import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Evidence, Run, ServiceMap, ServiceMapState } from "../shared/model.ts";
import { sameDomain } from "./domain.mjs";
import { identify } from "./screens.ts";

const safeSegments = new Set(("api graphql rest rpc v auth oauth login logout signin signout callback " +
  "users user me profile account accounts settings catalog products product categories category " +
  "orders order shipment shipments shipping cart checkout payments payment search filter filters " +
  "items item details detail inventory stock health status events event collect analytics " +
  "home index html app shop store es en fr de it pt ca dashboard reports report projects project " +
  "customers customer sessions session refresh token reset password verify notification notifications " +
  "assets static css js images image fonts public private admin content page pages list " +
  "redirect destination external popup data submit create update delete upload download c p").split(" "));

// Keep known route words. Unknown segments may be identifiers or user data.
export function normalizedUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return;
    const sensitive = /^(token|reset|password|verify|callback)$/i;
    let hideNext = false;
    const path = url.pathname.split("/").map(segment => {
      if (!segment) return "";
      let value;
      try { value = decodeURIComponent(segment); } catch { return "{value}"; }
      const hidden = hideNext;
      hideNext = sensitive.test(value);
      if (hidden) return "{value}";
      if (/^\d+$/.test(value) || /^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(value)) return "{id}";
      if (/^v\d{1,3}$/i.test(value) || safeSegments.has(value.toLowerCase())) return value;
      return "{value}";
    }).join("/");
    return new URL(url.origin + path);
  } catch { return; }
}

const key = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
export function emptyServiceMap(runId: string, state: ServiceMapState): ServiceMap {
  return {
    schemaVersion: 1, runId, state,
    coverage: { reasons: [], examined: 0, included: 0, excludedType: 0, invalid: 0, bytesRead: 0 },
    screens: [], services: [], operations: [], observations: [],
  };
}

type Limits = { bytes: number; lineBytes: number; observations: number };
type Snapshot = { pageId: string; time: number; url?: string };
type ActionWindow = { id: number; start: number; end: number; pages: Set<string> };
type Source = { name: string; offset: number; timelines: Map<string, Snapshot[]>; actions: ActionWindow[] };
const defaults: Limits = { bytes: 64 * 1024 * 1024, lineBytes: 1024 * 1024, observations: 10000 };

// Yield complete, bounded lines only. A killed writer may leave an incomplete tail.
async function* lines(path: string, map: ServiceMap, limits: Limits) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw Error("Invalid trace file");
    let parts: Buffer[] = [], size = 0, dropping = false, line = 0;
    while (map.coverage.bytesRead < limits.bytes) {
      const buffer = Buffer.alloc(Math.min(65536, limits.bytes - map.coverage.bytesRead));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      const data = buffer.subarray(0, bytesRead);
      map.coverage.bytesRead += data.length;
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 10) continue;
        const part = data.subarray(start, i);
        size += part.length;
        if (!dropping && size <= limits.lineBytes) {
          parts.push(part);
          yield { text: Buffer.concat(parts).toString("utf8"), line: ++line };
        } else {
          line++;
          map.coverage.invalid++;
          addReason(map, "line-limit");
        }
        parts = [];
        size = 0;
        dropping = false;
        start = i + 1;
      }
      const tail = data.subarray(start);
      size += tail.length;
      if (size > limits.lineBytes) {
        parts = [];
        dropping = true;
      } else if (!dropping) parts.push(tail);
      if (map.coverage.bytesRead >= limits.bytes) {
        addReason(map, "byte-limit");
        return;
      }
    }
    if (size || dropping) {
      map.coverage.invalid++;
      addReason(map, "truncated-line");
    }
  } finally { await file.close(); }
}

function addReason(map: ServiceMap, reason: string) {
  if (!map.coverage.reasons.includes(reason)) map.coverage.reasons.push(reason);
}
function parse(text: string, map: ServiceMap) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object") throw Error();
    return value;
  } catch {
    map.coverage.invalid++;
    addReason(map, "invalid-record");
  }
}

async function readSource(root: string, name: string, map: ServiceMap, limits: Limits, evidence: Evidence[]): Promise<Source | undefined> {
  let offset: number | undefined;
  const snapshots: Snapshot[] = [];
  for await (const line of lines(join(root, name + ".trace"), map, limits)) {
    const event = parse(line.text, map);
    if (!event) continue;
    if (event.type === "context-options") {
      if (event.version !== 10 || !Number.isFinite(event.wallTime) || !Number.isFinite(event.monotonicTime)) {
        addReason(map, "unsupported-format");
        return;
      }
      offset = event.wallTime - event.monotonicTime;
    }
    const s = event.snapshot;
    if (event.type === "frame-snapshot" && s?.isMainFrame === true &&
        typeof s.pageId === "string" && Number.isFinite(s.timestamp) && offset !== undefined) {
      let raw = s.frameUrl;
      try {
        const url = new URL(raw);
        const route = url.hash.match(/^#!?(\/[^?]*)/)?.[1];
        if (route) raw = url.origin + route;
      } catch { /* Unknown locations stay unidentified. */ }
      snapshots.push({ pageId: s.pageId, time: offset + s.timestamp, url: normalizedUrl(raw)?.href });
    }
  }
  if (offset === undefined) { addReason(map, "unsupported-format"); return; }
  snapshots.sort((a, b) => a.time - b.time);
  const timelines = new Map<string, Snapshot[]>();
  for (const snapshot of snapshots) {
    const timeline = timelines.get(snapshot.pageId) ?? [];
    timeline.push(snapshot);
    timelines.set(snapshot.pageId, timeline);
  }
  const actions = evidence.flatMap(e => {
    const start = Date.parse(e.startedAt ?? ""), end = Date.parse(e.finishedAt ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    const pages = new Set(snapshots.filter(s => start <= s.time && s.time <= end).map(s => s.pageId));
    return [{ id: e.id, start, end, pages }];
  });
  return { name, offset, timelines, actions };
}

function screenFor(source: Source, pageId: string, started: number) {
  const timeline = source.timelines.get(pageId) ?? [];
  let low = 0, high = timeline.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (timeline[middle].time <= started) low = middle + 1;
    else high = middle;
  }
  const before = timeline[low - 1], after = timeline[low];
  // A route change between snapshots has no reliable navigation timestamp.
  if (!before?.url || (after && after.url !== before.url)) return;
  const screen = identify(before.url);
  return screen && { key: decodeURI(screen.key), label: decodeURI(screen.label) };
}

function actionFor(source: Source, pageId: string, started: number) {
  const windows = source.actions.filter(e => e.start <= started && started <= e.end);
  if (windows.length !== 1) return;
  const action = windows[0];
  if (action.pages.size === 1 && action.pages.has(pageId)) return action.id;
}

export async function buildServiceMap(
  dir: string, run: Pick<Run, "id" | "url" | "createdAt" | "status">, evidence: Evidence[], overrides: Partial<Limits> = {},
): Promise<ServiceMap> {
  const map = emptyServiceMap(run.id, "unavailable");
  const limits = { ...defaults, ...overrides };
  try {
    if ((await lstat(dir)).isSymbolicLink()) throw Error("Invalid run directory");
    const root = join(await realpath(dir), "traces");
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw Error("Missing traces");
    const files = (await readdir(root, { withFileTypes: true }))
      .filter(f => f.isFile() && /^trace-[\w-]+\.network$/.test(f.name)).map(f => f.name).sort();
    if (!files.length) { addReason(map, "missing-trace"); return map; }
    let closed = false;
    try {
      const marker = await open(join(dir, "service-map-trace.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { closed = JSON.parse(await marker.readFile("utf8")).closed === true; } finally { await marker.close(); }
    } catch { /* An interrupted bridge may leave no close marker. */ }
    if (!closed || run.status === "interrupted" || run.status === "cancelled") addReason(map, "capture-interrupted");
    const sources: Source[] = [];
    for (const file of files) {
      try {
        const source = await readSource(root, file.slice(0, -8), map, limits, evidence);
        if (source) sources.push(source);
      } catch { addReason(map, "trace-unreadable"); }
      if (map.coverage.reasons.includes("byte-limit")) break;
    }
    if (!sources.length) return map;
    const screens = new Map<string, ServiceMap["screens"][number]>();
    const services = new Map<string, ServiceMap["services"][number]>();
    const operations = new Map<string, ServiceMap["operations"][number]>();
    network: for (const source of sources) {
      if (map.coverage.reasons.includes("byte-limit")) break;
      try {
        for await (const line of lines(join(root, source.name + ".network"), map, limits)) {
          const event = parse(line.text, map);
          if (!event) continue;
          map.coverage.examined++;
          const s = event.snapshot;
          if (event.type !== "resource-snapshot" || !s?.request || !s.response ||
              !Number.isFinite(Date.parse(s.startedDateTime)) || typeof s._resourceType !== "string" || typeof s.request.method !== "string" ||
              !/^[A-Za-z]{1,20}$/.test(s.request.method)) {
            map.coverage.invalid++; addReason(map, "invalid-record"); continue;
          }
          if (!["fetch", "xhr", "document"].includes(s._resourceType)) { map.coverage.excludedType++; continue; }
          const url = normalizedUrl(s.request.url);
          if (!url) { map.coverage.invalid++; addReason(map, "invalid-record"); continue; }
          if (map.observations.length >= limits.observations) {
            addReason(map, "observation-limit");
            break network;
          }
          const started = Date.parse(s.startedDateTime);
          const clockValid = Number.isFinite(s._monotonicTime) && Math.abs(source.offset + s._monotonicTime - started) <= 100;
          const pageId = typeof s.pageref === "string" ? s.pageref : "";
          const page = key(source.name + pageId);
          const screen = clockValid ? screenFor(source, pageId, started) : undefined;
          const screenId = key(page + (screen?.key ?? "unknown"));
          screens.set(screenId, { id: screenId, key: screen?.key ?? "", label: screen?.label ?? "Unidentified screen", page });
          const serviceId = key(url.origin);
          services.set(serviceId, { id: serviceId, origin: url.origin, external: !sameDomain(url.href, run.url) });
          const method = s.request.method.toUpperCase();
          const path = decodeURI(url.pathname);
          const operationId = key(serviceId + method + path);
          operations.set(operationId, { id: operationId, serviceId, method, path });
          map.observations.push({
            id: source.name + ":" + line.line, operationId, screenId,
            resourceType: s._resourceType, startedMs: Math.round(started - Date.parse(run.createdAt)),
            status: Number.isInteger(s.response.status) && s.response.status >= 100 && s.response.status <= 599 ? s.response.status : null,
            failed: typeof s.response._failureText === "string" && s.response._failureText.length > 0,
            durationMs: Number.isFinite(s.time) && s.time >= 0 ? Math.round(s.time * 10) / 10 : null,
            evidenceId: clockValid ? actionFor(source, pageId, started) : undefined,
          });
          map.coverage.included++;
        }
      } catch { addReason(map, "trace-unreadable"); }
    }
    map.screens = [...screens.values()];
    map.services = [...services.values()];
    map.operations = [...operations.values()];
    map.state = map.coverage.reasons.length ? "partial" : "ready";
    if (!map.coverage.included && !map.coverage.excludedType && map.coverage.invalid) map.state = "unavailable";
  } catch {
    addReason(map, "trace-unreadable");
    map.state = map.observations.length ? "partial" : "unavailable";
  }
  return map;
}
