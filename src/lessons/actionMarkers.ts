// Action markers in lesson step markdown: a line `[[action:bleed]]` (or
// `[[action:bolus,transfuse]]`) places those action buttons at that point in
// the step text, so a learner presses a button where the text names it.
// useLesson renders the markdown pieces in between; LessonStepPanel renders
// the buttons. Actions without a marker stay in the row under the text.
//
// A line `[[reveal]]` hides the rest of the step text behind a Continue button:
// put it after a question so learners think before they read the answer.

// A step's text as rendered blocks: markdown, a row of action buttons placed by
// a `[[action:id,id]]` marker line, or a `[[reveal]]` point.
export type StepBlock =
  | { kind: "html"; html: string }
  | { kind: "actions"; ids: string[] }
  | { kind: "reveal"; pending?: boolean }; // pending: not yet opened (shows Continue)
export type MarkerBlock = { kind: "md"; md: string } | { kind: "actions"; ids: string[] } | { kind: "reveal" };

const ACTION_MARKER = /^\s*\[\[action:\s*([\w-]+(?:\s*,\s*[\w-]+)*)\s*\]\]\s*$/;
const REVEAL_MARKER = /^\s*\[\[reveal\]\]\s*$/;

// split raw step markdown at marker lines
export function splitActionMarkers(raw: string): MarkerBlock[] {
  const out: MarkerBlock[] = [];
  let buf: string[] = [];
  const flush = () => {
    const md = buf.join("\n");
    if (md.trim()) out.push({ kind: "md", md });
    buf = [];
  };
  for (const line of raw.split(/\r?\n/)) {
    if (REVEAL_MARKER.test(line)) {
      flush();
      out.push({ kind: "reveal" });
      continue;
    }
    const m = ACTION_MARKER.exec(line);
    if (!m) {
      buf.push(line);
      continue;
    }
    flush();
    out.push({ kind: "actions", ids: m[1].split(",").map((s) => s.trim()) });
  }
  flush();
  return out;
}
