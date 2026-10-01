import { defineTour } from "@/manual/types";

// Chapter 11: the Explain AI bot — asking questions about the live patient,
// confirm-before-apply action cards, Guided/Full scope, auto-apply, building a
// patient from attachments, revert and new conversation.
const onChat = [{ tab: "viz", value: "chat" }] as const;

export default defineTour({
  id: "ai-bot",
  title: "The Explain AI bot",
  summary: "Ask about the patient in plain language, and let the bot propose changes or build a patient.",
  chapter: "AI bot",
  order: 60,
  steps: [
    {
      id: "open",
      title: "Open the AI bot",
      target: "tab.viz.chat",
      placement: "bottom",
      advanceOn: { tab: "viz", value: "chat" },
    },
    { id: "intro", title: "Talking to the bot", target: "chat.conversation", placement: "right", ui: [...onChat] },
    { id: "composer", title: "Asking", target: "chat.composer", placement: "top", ui: [...onChat] },
    { id: "actions", title: "Proposed actions", target: "chat.conversation", placement: "right", ui: [...onChat] },
    { id: "can-do", title: "What the bot can do", target: "chat.conversation", placement: "right", ui: [...onChat] },
    { id: "scope", title: "Guided or Full", target: "chat.scope", placement: "bottom", ui: [...onChat] },
    { id: "autoapply", title: "Auto-apply", target: "chat.autoapply", placement: "bottom", ui: [...onChat] },
    { id: "attach", title: "Build a patient from a file", target: "chat.attach", placement: "top", ui: [...onChat] },
    { id: "revert", title: "Revert and start a new conversation", target: "chat.revert", placement: "bottom", ui: [...onChat] },
  ],
});
