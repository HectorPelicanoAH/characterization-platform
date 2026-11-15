import type { Evidence } from "../shared/model.ts";

export type Screen = { key: string; label: string };
export function identify(raw: string, title?: string): Screen | undefined {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return;
    const path = (u.hash.match(/^#!?(\/[^?]*)/)?.[1] ?? u.pathname).replace(/\/+$/, "") || "/";
    const catalogRoute = path.match(/^\/[a-z]{2}\/[a-z]{2}\/(c|p|search)(?:\/|$)/);
    if (catalogRoute) {
      const labels: Record<string,string> = { c:"Product listing", p:"Product details", search:"Search" };
      return {key:u.origin+"/:"+catalogRoute[1], label:labels[catalogRoute[1]]};
    }
    return {key:u.origin+path, label:title?.trim() || (path === "/" ? "Home" : path)};
  } catch { return; }
}

export function screensFor(ids:number[], events:Evidence[]):Screen[] {
  const selected=new Set(ids), screens=new Map<string,Screen>();
  for (const e of events) {
    if (!e.ok || !selected.has(e.id)) continue;
    const url=e.detail.match(/^- Page URL:\s*(https?:\/\/\S+)/m)?.[1];
    const title=e.detail.match(/^- Page Title:\s*(.+)/m)?.[1];
    for(const raw of [url,...(e.externalUrls ?? (e.externalUrl?[e.externalUrl]:[]))]) {
      const screen=raw && identify(raw, raw===url ? title : undefined);
      if(screen && !screens.has(screen.key)) screens.set(screen.key,screen);
    }
  }
  return [...screens.values()];
}
