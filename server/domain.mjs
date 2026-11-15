import { getDomain } from "tldts";

export function sameDomain(first, second) {
  const a = new URL(first),
    b = new URL(second);
  if (
    !["http:", "https:"].includes(a.protocol) ||
    !["http:", "https:"].includes(b.protocol)
  )
    return false;
  const domain = (url) =>
    getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname;
  return domain(a) === domain(b);
}

export function pageUrlFromResult(text) {
  return text.match(/(?:^|\n)\s*-?\s*Page URL:\s*(https?:\/\/\S+)/i)?.[1];
}

export function externalUrlsFromResult(text, origin) {
  const page = pageUrlFromResult(text);
  const tabsSection =
    text.match(/### Open tabs\n([\s\S]*?)(?=\n### |$)/)?.[1] ?? "";
  const tabs = [
    ...tabsSection.matchAll(/^- \d+:.*\]\((https?:\/\/[^\n]+)\)(?: \[.*)?$/gm),
  ].map((match) => match[1]);
  return [
    ...new Set(
      [...(page ? [page] : []), ...tabs].filter((url) => {
        try {
          return !sameDomain(url, origin);
        } catch {
          return false;
        }
      }),
    ),
  ];
}
