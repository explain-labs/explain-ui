import type { Tour } from "@/manual/types";

// Tour registry. Each tour is a folder under src/manual/tours/<id>/:
//   tour.ts            defineTour({...}) as the default export
//   steps/<step>.md    markdown body of each step
// Tours load eagerly (they are tiny); step markdown loads lazily.

const tourModules = import.meta.glob<Tour>("./tours/*/tour.ts", {
  eager: true,
  import: "default",
});

const stepModules = import.meta.glob<string>("./tours/*/steps/*.md", {
  query: "?raw",
  import: "default",
});

const TOURS: Record<string, Tour> = {};
for (const [key, tour] of Object.entries(tourModules)) {
  const folder = key.split("/")[2];
  if (tour.id !== folder) console.warn(`tour id "${tour.id}" does not match its folder "${folder}"`);
  TOURS[tour.id] = tour;
}

export function getTour(id: string): Tour | undefined {
  return TOURS[id];
}

export function listTours(): Tour[] {
  return Object.values(TOURS).sort((a, b) => a.order - b.order);
}

// Tours grouped by chapter, chapters in the order of their first tour.
export function toursByChapter(): { chapter: string; tours: Tour[] }[] {
  const out: { chapter: string; tours: Tour[] }[] = [];
  for (const t of listTours()) {
    let c = out.find((x) => x.chapter === t.chapter);
    if (!c) out.push((c = { chapter: t.chapter, tours: [] }));
    c.tours.push(t);
  }
  return out;
}

// Raw markdown for a step, or "" if the file is missing.
export async function loadStepMarkdown(tourId: string, stepId: string): Promise<string> {
  const loader = stepModules[`./tours/${tourId}/steps/${stepId}.md`];
  return loader ? loader() : "";
}
