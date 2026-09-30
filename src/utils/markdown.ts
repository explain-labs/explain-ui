import MarkdownIt from "markdown-it";

// Markdown renderer for lesson text. Same guard as DocViewer/ChatPanel —
// html:false, so v-html only ever receives markdown-it's own escaped output.
// External links open in a new tab; relative image paths are resolved through
// `env.resolveImage` so lesson markdown can write ![](img/heart.svg).
export interface MarkdownEnv {
  resolveImage?: (src: string) => string | undefined;
}

const md = new MarkdownIt({ html: false, linkify: true });

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env: MarkdownEnv, self) => {
  const token = tokens[idx];
  const src = token.attrGet("src") ?? "";
  if (src && !/^([a-z]+:|\/)/i.test(src)) {
    const url = env?.resolveImage?.(src);
    if (url) token.attrSet("src", url);
  }
  return defaultImage(tokens, idx, options, env, self);
};

export function renderMarkdown(src: string, env: MarkdownEnv = {}): string {
  return md.render(src, env);
}
