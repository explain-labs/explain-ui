<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import MarkdownIt from "markdown-it";
import Panel from "primevue/panel";
import Button from "primevue/button";
import Textarea from "primevue/textarea";
import ToggleSwitch from "primevue/toggleswitch";
import SelectButton from "primevue/selectbutton";
import type { CommandScope } from "@/services/botCommands";
import { useChatStore, type ChatAttachment } from "@/stores/chat";
import { useExplain } from "@/composables/useExplain";

// live-tune status + "undo my changes" (revert to the patient as loaded)
const { tuning, revert } = useExplain();

// Chat with the "explain-labs_claude" bot (built specifically for this project).
// State + the /api/chat call live in the chat store; this is just the
// conversation UI. Assistant replies are markdown (the bot is a Claude Agent-SDK
// bot), so they're rendered via markdown-it; user/failed bubbles stay plain text.

// `html: false` escapes any raw HTML in the model output (the main XSS guard);
// linkify autolinks bare URLs; breaks turns single newlines into <br>.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// Open links in a new tab, safely (rel=noopener noreferrer).
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const renderMd = (text: string): string => md.render(text);

import type { ChatMessage } from "@/stores/chat";

const chat = useChatStore();
const input = ref("");

// Files the user attaches for the bot to read (PDF case sheets, CSV value tables,
// images). The bot extracts target physiology from them to build a patient.
const attachments = ref<ChatAttachment[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const ACCEPT = ".pdf,.csv,.tsv,.txt,image/*,application/pdf,text/csv";

// read one File into a ChatAttachment: base64 for pdf/image, raw text for csv/txt.
function readFile(file: File): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const isText = /\.(csv|tsv|txt)$/i.test(file.name) || file.type === "text/csv" || file.type.startsWith("text/");
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    reader.onerror = () => reject(reader.error ?? new Error(`could not read ${file.name}`));
    reader.onload = () => {
      if (isText) {
        resolve({ kind: "csv", name: file.name, data: String(reader.result ?? "") });
        return;
      }
      // data URL -> strip the "data:<mt>;base64," prefix, keep the media type
      const result = String(reader.result ?? "");
      const m = /^data:([^;]+);base64,(.*)$/s.exec(result);
      const media_type = m?.[1] ?? (isPdf ? "application/pdf" : file.type || "application/octet-stream");
      const data = m?.[2] ?? "";
      resolve({ kind: isPdf ? "pdf" : "image", name: file.name, data, media_type });
    };
    if (isText) reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

async function onFiles(e: Event) {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  for (const f of files) {
    try {
      attachments.value.push(await readFile(f));
    } catch (err) {
      chat.error = (err as Error).message;
    }
  }
  if (fileInput.value) fileInput.value.value = ""; // allow re-selecting the same file
}

function removeAttachment(i: number) {
  attachments.value.splice(i, 1);
}

// command surface: Guided = curated allowlist, Full = any settable model field
const SCOPES = [
  { label: "Guided", value: "guided" },
  { label: "Full", value: "full" },
];
function onScope(v: CommandScope | null) {
  if (v) chat.commandScope = v; // SelectButton can emit null on re-click; ignore
}

// show "Apply all" only when a message has 2+ still-applicable commands
function hasMultiplePending(m: ChatMessage): boolean {
  return (m.commands?.filter((c) => c.status === "pending").length ?? 0) > 1;
}
const scrollEnd = ref<HTMLDivElement | null>(null);

async function send() {
  const text = input.value;
  if ((!text.trim() && !attachments.value.length) || chat.isLoading) return;
  const files = attachments.value;
  input.value = "";
  attachments.value = [];
  await chat.sendMessage(text, files);
}

// Enter sends, Shift+Enter inserts a newline.
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

// auto-scroll to the newest message / the loading indicator
watch(
  () => [chat.messages.length, chat.isLoading],
  async () => {
    await nextTick();
    scrollEnd.value?.scrollIntoView({ behavior: "smooth" });
  },
);
</script>

<template>
  <Panel toggleable data-tour="chat.panel">
    <template #header>
      <div class="flex items-center justify-between w-full">
        <span class="font-semibold">Explain AI Bot</span>
        <div class="flex items-center gap-2">
          <SelectButton
            data-tour="chat.scope"
            v-tooltip.top="'Command surface: Guided = curated safe set; Full = any settable model parameter'"
            :model-value="chat.commandScope"
            :options="SCOPES"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            size="small"
            @update:model-value="onScope"
          />
          <label
            data-tour="chat.autoapply"
            v-tooltip.top="'When on, bot commands run immediately without an Apply click'"
            class="flex items-center gap-1 text-xs opacity-80 cursor-pointer"
          >
            <ToggleSwitch v-model="chat.autoApply" />
            <span :class="chat.autoApply ? 'text-amber-400' : ''">Auto-apply</span>
          </label>
          <Button
            data-tour="chat.revert"
            v-tooltip.top="'Revert all live changes — reload the patient as it was loaded'"
            icon="pi pi-undo"
            text
            rounded
            size="small"
            aria-label="Revert changes"
            @click="revert()"
          />
          <Button
            v-tooltip.top="'New conversation'"
            icon="pi pi-plus"
            text
            rounded
            size="small"
            aria-label="New conversation"
            @click="chat.newConversation()"
          />
        </div>
      </div>
    </template>

    <div class="flex flex-col gap-2">
      <!-- conversation -->
      <div
        data-tour="chat.conversation"
        class="h-[60vh] overflow-y-auto rounded border border-surface-700 p-2 flex flex-col gap-2"
      >
        <p v-if="!chat.messages.length" class="text-xs opacity-50 m-auto text-center">
          Ask Explain Labs about the current patient.
        </p>
        <div
          v-for="(m, i) in chat.messages"
          :key="i"
          :class="[
            'max-w-[85%] rounded px-2 py-1 text-sm break-words',
            m.role === 'user'
              ? 'self-end bg-primary-700 text-white'
              : m.failed
                ? 'self-start bg-red-900/60 text-red-100'
                : 'self-start bg-surface-800',
          ]"
        >
          <!-- assistant replies are markdown; user input + error bubbles stay verbatim -->
          <div
            v-if="m.role === 'assistant' && !m.failed && m.text"
            class="md-body"
            v-html="renderMd(m.text)"
          ></div>
          <span v-else-if="m.role !== 'assistant' || m.failed" class="whitespace-pre-wrap">{{
            m.text
          }}</span>

          <!-- attachments the user sent with this turn -->
          <div v-if="m.attachments?.length" class="mt-1 flex flex-wrap gap-1">
            <span
              v-for="(a, ai) in m.attachments"
              :key="ai"
              class="inline-flex items-center gap-1 rounded bg-black/25 px-1.5 py-0.5 text-[10px]"
            >
              <i class="pi pi-paperclip text-[9px]"></i>{{ a.name }}
            </span>
          </div>

          <!-- bot-proposed actions: confirm-before-apply -->
          <div v-if="m.commands?.length" class="mt-2 flex flex-col gap-1.5">
            <div
              v-for="(pc, ci) in m.commands"
              :key="ci"
              class="rounded border border-surface-600 bg-surface-900/60 px-2 py-1.5 text-xs"
            >
              <div class="flex items-center gap-1.5">
                <i class="pi pi-bolt text-[10px] opacity-70"></i>
                <span class="font-mono break-all flex-1">{{ pc.description }}</span>
                <span
                  v-if="pc.status === 'applied'"
                  class="text-green-400 whitespace-nowrap"
                  ><i class="pi pi-check text-[10px]"></i> applied</span
                >
                <span
                  v-else-if="pc.status === 'dismissed'"
                  class="opacity-50 whitespace-nowrap"
                  >dismissed</span
                >
                <span
                  v-else-if="pc.status === 'invalid'"
                  class="text-amber-400 whitespace-nowrap"
                  >can't apply</span
                >
              </div>
              <p v-if="pc.error" class="text-amber-400/80 mt-0.5 leading-tight">{{ pc.error }}</p>
              <div v-if="pc.status === 'pending'" class="mt-1 flex gap-1.5">
                <Button
                  label="Apply"
                  icon="pi pi-check"
                  size="small"
                  class="!py-0.5 !text-xs"
                  @click="chat.applyCommand(i, ci)"
                />
                <Button
                  label="Dismiss"
                  icon="pi pi-times"
                  size="small"
                  text
                  class="!py-0.5 !text-xs"
                  @click="chat.dismissCommand(i, ci)"
                />
              </div>
            </div>
            <Button
              v-if="hasMultiplePending(m)"
              label="Apply all"
              size="small"
              text
              class="self-start !py-0.5 !text-xs"
              @click="chat.applyAll(i)"
            />
          </div>
        </div>
        <div v-if="chat.isLoading" class="self-start text-xs opacity-60 px-2 py-1">
          <i class="pi pi-spin pi-spinner mr-1"></i> thinking…
        </div>
        <div v-if="tuning" class="self-start text-xs text-amber-400 px-2 py-1">
          <i class="pi pi-spin pi-spinner mr-1"></i> tuning the model to target…
        </div>
        <div ref="scrollEnd"></div>
      </div>

      <!-- pending attachments (cleared on send) -->
      <div v-if="attachments.length" class="flex flex-wrap gap-1">
        <span
          v-for="(a, ai) in attachments"
          :key="ai"
          class="inline-flex items-center gap-1 rounded border border-surface-600 bg-surface-800 px-1.5 py-0.5 text-[11px]"
        >
          <i class="pi pi-file text-[10px] opacity-70"></i>{{ a.name }}
          <i
            class="pi pi-times text-[10px] cursor-pointer opacity-60 hover:opacity-100"
            @click="removeAttachment(ai)"
          ></i>
        </span>
      </div>

      <!-- composer -->
      <div class="flex items-end gap-2" data-tour="chat.composer">
        <input
          ref="fileInput"
          type="file"
          :accept="ACCEPT"
          multiple
          class="hidden"
          @change="onFiles"
        />
        <Button
          data-tour="chat.attach"
          v-tooltip.top="'Attach a PDF / CSV / image of target values for the bot to build a patient from'"
          icon="pi pi-paperclip"
          aria-label="Attach file"
          severity="secondary"
          :disabled="chat.isLoading"
          @click="fileInput?.click()"
        />
        <Textarea
          v-model="input"
          placeholder="Ask about the patient, or describe a patient to build…  (Enter to send, Shift+Enter for newline)"
          rows="2"
          auto-resize
          class="flex-1 text-sm"
          :disabled="chat.isLoading"
          @keydown="onKeydown"
        />
        <Button
          icon="pi pi-send"
          aria-label="Send"
          :disabled="(!input.trim() && !attachments.length) || chat.isLoading"
          @click="send"
        />
      </div>

      <p v-if="chat.error" class="text-[11px] text-red-400 leading-tight">
        {{ chat.error }}
      </p>
    </div>
  </Panel>
</template>

<style scoped>
/* Markdown-rendered assistant bubbles. Tailwind's preflight strips list markers
   and heading sizes, so restore a compact, readable set here. Scoped + :deep()
   because the HTML is injected via v-html. */
.md-body :deep(> *:first-child) {
  margin-top: 0;
}
.md-body :deep(> *:last-child) {
  margin-bottom: 0;
}
.md-body :deep(p) {
  margin: 0.4rem 0;
}
.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 0.4rem 0;
  padding-left: 1.25rem;
}
.md-body :deep(ul) {
  list-style: disc;
}
.md-body :deep(ol) {
  list-style: decimal;
}
.md-body :deep(li) {
  margin: 0.15rem 0;
}
.md-body :deep(li > ul),
.md-body :deep(li > ol) {
  margin: 0.15rem 0;
}
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  font-weight: 600;
  line-height: 1.25;
  margin: 0.6rem 0 0.3rem;
}
.md-body :deep(h1) {
  font-size: 1.1rem;
}
.md-body :deep(h2) {
  font-size: 1.05rem;
}
.md-body :deep(h3),
.md-body :deep(h4) {
  font-size: 1rem;
}
.md-body :deep(a) {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.md-body :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85em;
  background: rgb(0 0 0 / 0.3);
  padding: 0.1em 0.3em;
  border-radius: 0.25rem;
}
.md-body :deep(pre) {
  margin: 0.4rem 0;
  padding: 0.5rem 0.6rem;
  background: rgb(0 0 0 / 0.35);
  border-radius: 0.375rem;
  overflow-x: auto;
}
.md-body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 0.8rem;
  line-height: 1.4;
}
.md-body :deep(blockquote) {
  margin: 0.4rem 0;
  padding-left: 0.6rem;
  border-left: 3px solid rgb(255 255 255 / 0.2);
  opacity: 0.85;
}
.md-body :deep(table) {
  border-collapse: collapse;
  margin: 0.4rem 0;
  font-size: 0.85em;
}
.md-body :deep(th),
.md-body :deep(td) {
  border: 1px solid rgb(255 255 255 / 0.15);
  padding: 0.2rem 0.4rem;
  text-align: left;
}
.md-body :deep(hr) {
  border: none;
  border-top: 1px solid rgb(255 255 255 / 0.15);
  margin: 0.6rem 0;
}
</style>
