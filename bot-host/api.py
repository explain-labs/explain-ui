"""
HTTP API in front of the cradle bot.

Runs as its own launchd-supervised process, parallel to the Telegram bot.
Both processes share cradle/workdir/ (so they see the same CLAUDE.md,
.claude/agents/, .mcp.json, data_secure/, scripts/) and the same
CLAUDE_CONFIG_DIR. They keep separate session stores:

  - Telegram bot   → sessions.json     (chat_id -> claude session_id)
  - this API       → api_sessions.json (conversation_id -> claude session_id)

Auth: static API keys from API_KEYS env (comma-separated), checked against
X-API-Key request header. Network exposure is handled outside (Tailscale).
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    TextBlock,
    query,
)
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field


load_dotenv(dotenv_path=Path.cwd() / ".env")

BOT_NAME = os.environ.get("BOT_NAME", "cradle")
MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-4-7")
ALLOWED_TOOLS = os.environ.get(
    "ALLOWED_TOOLS", "Read,Glob,Grep,WebSearch,WebFetch"
).split(",")
API_KEYS = {k.strip() for k in os.environ.get("API_KEYS", "").split(",") if k.strip()}

SUPPORTED_MEDIA_TYPES = ("image/jpeg", "image/png", "image/gif", "image/webp")
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGES_PER_REQUEST = 20

BOT_DIR = Path.cwd()
SESSIONS_FILE = BOT_DIR / "api_sessions.json"
OUTPUT_DIR = BOT_DIR / "output"
PATIENTS_DIR = BOT_DIR / "patients"  # built patient JSONs are archived here (audit)

# Patient-builder (the wrapper runs this itself — the bot only produces a SPEC, it
# is NOT granted shell). EXPLAIN_REPO is the checkout holding scripts/build_patient.mjs.
EXPLAIN_REPO = Path(os.environ.get("EXPLAIN_REPO", str(BOT_DIR.parent / "explain-repo")))
# build_patient.mjs moved into the `explain-engine` submodule when the engine was
# split into its own repo; it now lives under explain-engine/scripts/ in the checkout.
BUILD_SCRIPT = EXPLAIN_REPO / "explain-engine" / "scripts" / "build_patient.mjs"
NODE_BIN = os.environ.get("NODE_BIN") or shutil.which("node") or "/opt/homebrew/bin/node"
BUILD_TIMEOUT = int(os.environ.get("BUILD_TIMEOUT", "300"))
BUILD_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_BYTES", 10 * 1024 * 1024))
MAX_TOTAL_FILE_BYTES = int(os.environ.get("MAX_TOTAL_FILE_BYTES", 25 * 1024 * 1024))

logging.basicConfig(
    level=logging.INFO,
    format=f"%(asctime)s [{BOT_NAME}-api] %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(f"{BOT_NAME}-api")

if not API_KEYS:
    log.warning(
        "API_KEYS is empty — every request will be rejected. "
        "Set API_KEYS=<hex>[,<hex>...] in .env"
    )


# ---------- session persistence ----------

def load_sessions() -> dict[str, str]:
    if SESSIONS_FILE.exists():
        try:
            return json.loads(SESSIONS_FILE.read_text())
        except json.JSONDecodeError:
            log.warning("api_sessions.json was corrupt; starting fresh")
    return {}


def save_sessions(s: dict[str, str]) -> None:
    SESSIONS_FILE.write_text(json.dumps(s, indent=2))


sessions: dict[str, str] = load_sessions()


# ---------- output-file collection ----------
#
# Files Claude generates during a turn (PNGs, reports, etc.) are returned to the
# caller as base64 blobs. We only scan `output/` — by convention that's where
# generated artifacts live — so anything outside that dir can't leak.

def snapshot_output() -> dict[str, float]:
    """Map abs-path -> mtime for every file under OUTPUT_DIR."""
    snap: dict[str, float] = {}
    if not OUTPUT_DIR.is_dir():
        return snap
    for dirpath, dirnames, filenames in os.walk(OUTPUT_DIR):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "__pycache__"]
        for fn in filenames:
            if fn.startswith("."):
                continue
            p = Path(dirpath) / fn
            try:
                snap[str(p)] = p.stat().st_mtime
            except OSError:
                pass
    return snap


def collect_new_output_files(pre: dict[str, float]) -> list[FileOutput]:
    """Files under OUTPUT_DIR that are new or modified since `pre`, base64-encoded."""
    post = snapshot_output()
    files: list[FileOutput] = []
    total = 0
    for path_str, mtime in post.items():
        if pre.get(path_str) == mtime:
            continue
        p = Path(path_str)
        try:
            size = p.stat().st_size
        except OSError:
            continue
        if size > MAX_FILE_BYTES:
            log.info("skip %s: %d bytes > MAX_FILE_BYTES=%d", p, size, MAX_FILE_BYTES)
            continue
        if total + size > MAX_TOTAL_FILE_BYTES:
            log.info("skip %s: would exceed MAX_TOTAL_FILE_BYTES=%d", p, MAX_TOTAL_FILE_BYTES)
            continue
        try:
            raw = p.read_bytes()
        except OSError:
            continue
        media_type, _ = mimetypes.guess_type(p.name)
        if not media_type:
            media_type = "application/octet-stream"
        files.append(FileOutput(
            filename=str(p.relative_to(OUTPUT_DIR)),
            media_type=media_type,
            data=base64.b64encode(raw).decode("ascii"),
        ))
        total += size
    return files


# ---------- attachments + built-patient artifact ----------

def attachment_block(att: AttachmentInput) -> dict:
    """Convert an uploaded file into an Anthropic content block.

    pdf -> document block, image -> image block, csv/text -> a text block.
    """
    if att.kind == "image":
        return {
            "type": "image",
            "source": {"type": "base64", "media_type": att.media_type or "image/png", "data": att.data},
        }
    if att.kind == "pdf":
        return {
            "type": "document",
            "source": {"type": "base64", "media_type": att.media_type or "application/pdf", "data": att.data},
        }
    # csv / text: hand the model the raw text
    return {"type": "text", "text": f"Attached file '{att.name}':\n{att.data}"}


# The bot requests a patient build by emitting ONE fenced ```explain-build``` block
# holding a build SPEC (it does NOT run anything — the wrapper runs the builder).
_BUILD_RE = re.compile(r"```explain-build\s*(\{.*?\})\s*```", re.S)


def _safe_name(s: object) -> str:
    out = re.sub(r"[^A-Za-z0-9_-]", "_", str(s))[:64]
    return out or "patient"


# The builder writes its calibration report to stderr. One line per reported vital:
#   "  hr           147.31  (target 150, Δ -2.69)  [ok]"   (the target part is optional)
# and a closing line:
#   "  calibration CONVERGED after 4 iter — all targets met"
_NUM = r"-?\d+(?:\.\d+)?"
_RESIDUAL_RE = re.compile(
    rf"^\s*([a-z0-9_]+)\s+({_NUM})(?:\s+\(target ({_NUM}), Δ ({_NUM})\))?\s+\[([^\]]*)\]\s*$"
)
_VERDICT_RE = re.compile(r"calibration (CONVERGED|INCOMPLETE) after (\d+) iter — (.*)$")
BUILD_LOG_MAX_CHARS = 8000


def parse_build_report(stderr: str) -> dict:
    """Turn the builder's stderr report into structured detail for the app.

    `residuals` holds every reported vital (targeted or not) with its normal-range
    flag, so the app can show what the one-line verdict hides: a target that is
    inside tolerance but out of range, or an untargeted vital that drifted."""
    residuals: list[dict] = []
    converged: bool | None = None
    iters: int | None = None
    unmet: list[str] = []
    for line in (stderr or "").splitlines():
        v = _VERDICT_RE.search(line)
        if v:
            converged = v.group(1) == "CONVERGED"
            iters = int(v.group(2))
            if not converged:
                unmet = [k.strip() for k in v.group(3).split(",") if k.strip()]
            continue
        m = _RESIDUAL_RE.match(line)
        if m:
            key, value, target, delta, flag = m.groups()
            residuals.append({
                "key": key,
                "value": float(value),
                "target": float(target) if target is not None else None,
                "delta": float(delta) if delta is not None else None,
                "flag": flag.strip(),
            })
    return {
        "converged": converged,
        "iters": iters,
        "unmet": unmet,
        "residuals": residuals,
        "log": (stderr or "")[-BUILD_LOG_MAX_CHARS:],
    }


# Vitals passed to the app from the engine's build_report, in display order: the ones the
# stderr report shows, plus those the form can measure (sys/dia, rr, post-ductal SpO2,
# temperature, cardiac output) so the app can compare them with what was entered. `pp`
# (pulse pressure, sys - dia) is what the builder calibrates for a sys/dia pair.
_REPORT_VITALS = (
    "hr", "sys", "dia", "pp", "map", "cvp", "pap_m", "lvo", "rr", "spo2_pre", "spo2_post",
    "po2", "pco2", "ph", "be", "hco3", "temp",
)
# controller key -> the measured vital it reads (scripts/build_patient.mjs READKEY)
_TARGET_READ_KEY = {"spo2": "spo2_pre", "co": "lvo"}


def detail_from_build_report(report: dict, stderr: str) -> dict:
    """Same shape as parse_build_report(), built from the machine-readable build_report
    the engine's builder embeds in the scenario (explain-engine #7), plus what only that
    report carries: levers that ran into their bound, ignored and superseded targets,
    and notes."""
    measured = report.get("measured") if isinstance(report.get("measured"), dict) else {}
    targets = [t for t in report.get("targets") or [] if isinstance(t, dict) and isinstance(t.get("key"), str)]
    by_read_key = {_TARGET_READ_KEY.get(t["key"], t["key"]): t for t in targets}

    residuals: list[dict] = []
    for key in _REPORT_VITALS:
        m = measured.get(key)
        if not isinstance(m, dict) or not isinstance(m.get("value"), (int, float)):
            continue
        t = by_read_key.get(key)
        residuals.append({
            "key": key,
            "value": m["value"],
            "target": t.get("target") if t else None,
            "delta": t.get("delta") if t else None,
            "flag": m.get("flag") or "",
        })
    return {
        "converged": report.get("converged") if isinstance(report.get("converged"), bool) else None,
        "iters": report.get("iters") if isinstance(report.get("iters"), int) else None,
        "unmet": [t["key"] for t in targets if t.get("within") is False],
        "residuals": residuals,
        "lever_limits": [
            {"key": t["key"], "lever": t.get("lever"), "value": t.get("lever_value"), "bounds": t.get("lever_bounds")}
            for t in targets if t.get("lever_at_bound")
        ],
        "ignored_targets": [k for k in report.get("ignored_targets") or [] if isinstance(k, str)],
        "superseded_targets": [s for s in report.get("superseded_targets") or [] if isinstance(s, dict)],
        "notes": [n for n in report.get("notes") or [] if isinstance(n, str)],
        "source": "build_report",
        "log": (stderr or "")[-BUILD_LOG_MAX_CHARS:],
    }


def double_seed_error(spec: dict, baseline: str) -> str | None:
    """The builder applies its gestational-age seed (stiff lungs, reduced diffusion,
    venous trim — all multiplicative) whenever targets.gestational_age < 37, whatever
    the baseline. A baseline that is itself preterm already carries those adjustments,
    so the combination applies them twice. Fetal baselines use a separate seed table
    and are left alone."""
    targets = spec.get("targets")
    ga = targets.get("gestational_age") if isinstance(targets, dict) else None
    if not isinstance(ga, (int, float)) or isinstance(ga, bool) or ga >= 37:
        return None
    if spec.get("fetal") or "fetus" in baseline:
        return None
    path = EXPLAIN_REPO / "explain-engine" / "model_definitions" / f"{baseline}.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError, ValueError):
        return None  # unknown baseline: let the builder report it
    definition = data.get("model_definition", data) if isinstance(data, dict) else {}
    base_ga = definition.get("gestational_age") if isinstance(definition, dict) else None
    if not isinstance(base_ga, (int, float)) or isinstance(base_ga, bool) or base_ga >= 37:
        return None
    return (
        f"baseline {baseline!r} is already preterm ({base_ga:g} wk) and carries the "
        f"prematurity adjustments; adding gestational_age {ga:g} would apply them a "
        f"second time. Use baseline 'term_neonate' with gestational_age, or keep "
        f"{baseline!r} and leave gestational_age out"
    )


def run_build(spec: dict) -> tuple[dict | None, str, dict | None]:
    """Run scripts/build_patient.mjs with `spec` on stdin (fixed command, no shell).
    Returns (artifact, report, detail): artifact is the parsed scenario JSON or None
    on failure; report is a one-line human summary (convergence line or the error);
    detail is the structured calibration report (None on failure)."""
    if not BUILD_SCRIPT.exists():
        return None, f"builder not found at {BUILD_SCRIPT}", None
    baseline = str(spec.get("baseline", "term_neonate"))
    if not re.fullmatch(r"[A-Za-z0-9_]+", baseline):
        return None, f"invalid baseline name: {baseline!r}", None
    seed_error = double_seed_error(spec, baseline)
    if seed_error:
        return None, seed_error, None
    try:
        proc = subprocess.run(
            [NODE_BIN, str(BUILD_SCRIPT)],
            input=json.dumps(spec),
            capture_output=True,
            text=True,
            timeout=BUILD_TIMEOUT,
            cwd=str(EXPLAIN_REPO),
            env={**os.environ, "PATH": BUILD_PATH},
        )
    except subprocess.TimeoutExpired:
        return None, f"build timed out after {BUILD_TIMEOUT}s", None
    except Exception as e:  # noqa: BLE001
        return None, f"build failed to start: {e}", None

    if proc.returncode != 0 or not proc.stdout.strip():
        tail = "\n".join((proc.stderr or "").strip().splitlines()[-4:])
        return None, f"build failed (exit {proc.returncode}): {tail or 'no output'}", None
    try:
        artifact = json.loads(proc.stdout)
    except (json.JSONDecodeError, ValueError) as e:
        return None, f"build produced invalid JSON: {e}", None

    summary = ""
    for line in (proc.stderr or "").splitlines():
        if "calibration" in line and ("CONVERGED" in line or "INCOMPLETE" in line):
            summary = line.strip()
    name = _safe_name(spec.get("name") or artifact.get("name") or "patient")
    try:  # archive for audit (best-effort)
        (PATIENTS_DIR / f"{name}.json").write_text(proc.stdout)
    except OSError:
        pass
    # prefer the builder's own machine-readable report; parse the stderr text only for an
    # engine that predates it
    report = artifact.get("build_report") if isinstance(artifact, dict) else None
    if isinstance(report, dict):
        detail = detail_from_build_report(report, proc.stderr or "")
    else:
        detail = parse_build_report(proc.stderr or "")
        detail["source"] = "stderr"
    detail["spec"] = spec  # echoed so the app can check what was actually built
    return artifact, summary or "patient built", detail


def maybe_build(answer: str) -> tuple[str, dict | None, dict | None]:
    """If the reply contains an ```explain-build``` SPEC block, run the builder,
    strip the raw SPEC from the visible answer, splice in a loadDefinition command
    (so the app shows an Apply card), and return the built patient as the artifact
    together with the structured calibration report."""
    m = _BUILD_RE.search(answer or "")
    if not m:
        return answer, None, None
    block = m.group(0)
    try:
        spec = json.loads(m.group(1))
    except (json.JSONDecodeError, ValueError) as e:
        return answer.replace(block, f"\n⚠️ build spec was not valid JSON: {e}\n"), None, None
    if not isinstance(spec, dict):
        return answer.replace(block, "\n⚠️ build spec must be a JSON object\n"), None, None

    name = _safe_name(spec.get("name") or "patient")
    artifact, report, detail = run_build(spec)
    answer = answer.replace(block, "").strip()
    if artifact is None:
        return answer + f"\n\n⚠️ patient build failed: {report}", None, None
    summary = spec.get("summary") or report
    cmd = json.dumps({"op": "loadDefinition", "name": name, "summary": summary})
    answer = f"{answer}\n\n{report}\n\n```explain-command\n{cmd}\n```"
    return answer, artifact, detail


# ---------- claude call ----------

async def ask_clinical(
    prompt: str,
    conversation_id: str,
    images: list[ImageInput] | None = None,
    attachments: list[AttachmentInput] | None = None,
) -> tuple[str, str | None]:
    """Run one turn against the bot's Claude session, optionally with images/files."""
    options = ClaudeAgentOptions(
        cwd=str(BOT_DIR),
        model=MODEL,
        setting_sources=["project"],
        permission_mode="bypassPermissions",
        allowed_tools=ALLOWED_TOOLS,
        resume=sessions.get(conversation_id),
    )

    if images or attachments:
        async def stream():
            content: list[dict] = []
            for img in images or []:
                content.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": img.media_type,
                        "data": img.data,
                    },
                })
            for att in attachments or []:
                content.append(attachment_block(att))
            if prompt:
                content.append({"type": "text", "text": prompt})
            yield {
                "type": "user",
                "message": {"role": "user", "content": content},
                "parent_tool_use_id": None,
                "session_id": "default",
            }
        prompt_arg: object = stream()
    else:
        prompt_arg = prompt

    parts: list[str] = []
    new_session_id: str | None = sessions.get(conversation_id)

    async for message in query(prompt=prompt_arg, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    parts.append(block.text)
        elif isinstance(message, ResultMessage):
            new_session_id = message.session_id

    return "\n".join(parts).strip(), new_session_id


# ---------- auth ----------

def require_api_key(x_api_key: str | None = Header(default=None)) -> str:
    if not x_api_key or x_api_key not in API_KEYS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing X-API-Key",
        )
    return x_api_key


# ---------- HTTP schemas ----------

class ImageInput(BaseModel):
    data: str = Field(description="Base64-encoded image bytes (no 'data:' URI prefix)")
    media_type: Literal["image/jpeg", "image/png", "image/gif", "image/webp"]


class AttachmentInput(BaseModel):
    kind: Literal["pdf", "csv", "image", "text"]
    name: str = ""
    data: str = Field(description="Base64 for pdf/image; raw text for csv/text")
    media_type: str | None = None


class AskRequest(BaseModel):
    prompt: str = Field(default="", max_length=20000)
    conversation_id: str | None = None
    images: list[ImageInput] | None = Field(default=None, max_length=MAX_IMAGES_PER_REQUEST)
    attachments: list[AttachmentInput] | None = Field(default=None, max_length=20)


class FileOutput(BaseModel):
    filename: str
    media_type: str
    data: str = Field(description="Base64-encoded file bytes (no 'data:' URI prefix)")


class AskResponse(BaseModel):
    answer: str
    conversation_id: str
    files: list[FileOutput] = Field(default_factory=list)
    artifact: dict | None = None  # a bot-built patient definition (op:"loadDefinition")
    # calibration report for `artifact`: converged, iters, unmet, residuals, log, spec, source;
    # with a current engine also lever_limits, ignored_targets, superseded_targets, notes
    build: dict | None = None


# ---------- app ----------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    OUTPUT_DIR.mkdir(exist_ok=True)
    PATIENTS_DIR.mkdir(exist_ok=True)
    log.info(
        "%s-api up — model=%s, allowed_tools=%s, keys_configured=%d, sessions=%d, output_dir=%s",
        BOT_NAME, MODEL, ALLOWED_TOOLS, len(API_KEYS), len(sessions), OUTPUT_DIR,
    )
    yield


app = FastAPI(title="cradle-api", version="0.1.0", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True, "bot": BOT_NAME, "model": MODEL}


@app.post("/v1/ask", response_model=AskResponse)
async def ask(req: AskRequest, _key: str = Depends(require_api_key)) -> AskResponse:
    conversation_id = req.conversation_id or uuid.uuid4().hex

    if req.images:
        for i, img in enumerate(req.images):
            try:
                raw = base64.b64decode(img.data, validate=True)
            except (binascii.Error, ValueError):
                raise HTTPException(
                    status_code=400,
                    detail=f"image {i}: not valid base64",
                )
            if len(raw) > MAX_IMAGE_BYTES:
                raise HTTPException(
                    status_code=400,
                    detail=f"image {i}: {len(raw)} bytes exceeds {MAX_IMAGE_BYTES} limit",
                )

    log.info(
        "ask conv=%s resume=%s prompt_chars=%d images=%d attachments=%d",
        conversation_id, bool(sessions.get(conversation_id)),
        len(req.prompt), len(req.images) if req.images else 0,
        len(req.attachments) if req.attachments else 0,
    )

    pre_output = snapshot_output()

    try:
        answer, new_session_id = await ask_clinical(
            req.prompt, conversation_id, req.images, req.attachments
        )
    except Exception:
        log.exception("ask_clinical failed conv=%s", conversation_id)
        raise HTTPException(status_code=500, detail="claude call failed")

    if new_session_id and sessions.get(conversation_id) != new_session_id:
        sessions[conversation_id] = new_session_id
        save_sessions(sessions)

    if not answer:
        answer = "(no response)"

    files = collect_new_output_files(pre_output)
    if files:
        log.info("ask conv=%s returning %d file(s)", conversation_id, len(files))

    # if the bot asked to build a patient, run the builder here (off the event loop)
    answer, artifact, build = await asyncio.to_thread(maybe_build, answer)
    if artifact:
        log.info("ask conv=%s built patient -> artifact", conversation_id)

    return AskResponse(
        answer=answer, conversation_id=conversation_id, files=files, artifact=artifact,
        build=build,
    )


@app.delete("/v1/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str, _key: str = Depends(require_api_key)
) -> dict:
    existed = sessions.pop(conversation_id, None) is not None
    if existed:
        save_sessions(sessions)
    return {"deleted": existed, "conversation_id": conversation_id}
