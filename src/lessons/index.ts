import type { Lesson } from "@/lessons/types";
import type { Lang } from "@/lessons/i18n";

// Lesson registry. Each lesson is a folder under src/lessons/<id>/:
//   lesson.ts             defineLesson({...}) as the default export
//   steps/<step>.<lang>.md one markdown file per step per language
//   img/<file>             images referenced by steps (and from markdown as img/<file>)
// src/lessons/_shared/ holds reusable steps (the "how to read Explain" intro);
// it has no lesson.ts, and its steps name it via `source: "_shared"`.
// The lesson.ts files are small, so they load eagerly (the router guard needs
// hasLesson() synchronously); markdown loads lazily per step.

const lessonModules = import.meta.glob<Lesson>("./*/lesson.ts", {
  eager: true,
  import: "default",
});

const stepModules = import.meta.glob<string>("./*/steps/*.md", {
  query: "?raw",
  import: "default",
});

const imageModules = import.meta.glob<string>("./*/img/*.{png,jpg,jpeg,svg,webp,gif}", {
  eager: true,
  query: "?url",
  import: "default",
});

const LESSONS: Record<string, Lesson> = {};
for (const [key, lesson] of Object.entries(lessonModules)) {
  const folder = key.split("/")[1];
  if (lesson.id !== folder) {
    console.warn(`lesson id "${lesson.id}" does not match its folder "${folder}"`);
  }
  LESSONS[lesson.id] = lesson;
}

export function getLesson(id: string): Lesson | undefined {
  return LESSONS[id];
}

export function hasLesson(id: string | null | undefined): boolean {
  return !!id && id in LESSONS;
}

export function listLessons(): Lesson[] {
  return Object.values(LESSONS);
}

// Folder of a lesson id — normally equal to the id (warned above if not).
export function lessonFolder(lessonId: string): string {
  for (const [key, lesson] of Object.entries(lessonModules)) {
    if (lesson.id === lessonId) return key.split("/")[1];
  }
  return lessonId;
}

// Raw markdown for a step in `folder` (a lesson folder, or "_shared"), falling
// back to the other language. Empty string if neither file exists.
export async function loadStepMarkdown(folder: string, stepId: string, lang: Lang): Promise<string> {
  const other: Lang = lang === "nl" ? "en" : "nl";
  for (const l of [lang, other]) {
    const loader = stepModules[`./${folder}/steps/${stepId}.${l}.md`];
    if (loader) return loader();
  }
  return "";
}

// Bundled URL of an image in `folder`'s img/ directory, or undefined.
export function imageUrl(folder: string, file: string): string | undefined {
  const name = file.replace(/^(\.\/)?img\//, "");
  return imageModules[`./${folder}/img/${name}`];
}
