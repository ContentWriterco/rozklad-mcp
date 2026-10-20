import { mkdir, readFile, writeFile, stat, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config, log } from "./config.js";
import { dayFromYmd, nowLocal } from "./time.js";

export interface FeedDef {
  id: string;
  name: string;
  group: "trains" | "regional" | "city" | "custom";
  region?: string;
  city?: string;
  url?: string;
  fallbackUrls?: string[];
  discover?: { page: string; pattern: string; pick?: "first" | "last" | "covering" };
  homepage?: string;
  license?: string;
  attribution?: string;
  realtime?: { type: "mkuran-json"; url: string; license?: string; attribution?: string };
}

export interface FeedMeta {
  url: string;
  etag?: string;
  lastModified?: string;
  fetchedAt: number;
  checkedAt: number;
  size: number;
}

function registryPath(): string {
  if (config.feedsFile) return config.feedsFile;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "..", "feeds", "feeds.json"), join(here, "..", "..", "feeds", "feeds.json")]) {
    if (existsSync(p)) return p;
  }
  throw new Error("feeds/feeds.json not found");
}

export function loadRegistry(): FeedDef[] {
  const data = JSON.parse(readFileSync(registryPath(), "utf8")) as { feeds: FeedDef[] };
  const feeds = [...data.feeds];
  for (const part of config.extraFeeds.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const id = part.slice(0, eq).trim();
    const url = part.slice(eq + 1).trim();
    feeds.push({ id, name: id, group: "custom", url, license: "user-provided", attribution: url });
  }
  return feeds;
}

/** Resolve the ROZKLAD_FEEDS selection string against the registry. */
export function selectFeeds(all: FeedDef[], selection = config.feeds): FeedDef[] {
  const chosen = new Set<string>();
  const items = selection.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const it of items) {
    const neg = it.startsWith("-");
    const key = neg ? it.slice(1) : it;
    const match = all.filter(
      (f) =>
        key === "all" ||
        f.id.toLowerCase() === key ||
        f.group === key ||
        (key === "pks" && f.group === "regional") ||
        (key === "bus" && f.group === "regional") ||
        (key.startsWith("city:") && f.group === "city" && (f.city ?? "").toLowerCase() === key.slice(5)) ||
        (key.startsWith("region:") && (f.region ?? "").toLowerCase() === key.slice(7)),
    );
    if (match.length === 0 && !neg) log("warn", `Unknown feed or group in ROZKLAD_FEEDS: "${it}"`);
    for (const f of match) neg ? chosen.delete(f.id) : chosen.add(f.id);
  }
  // Custom feeds are always on.
  for (const f of all) if (f.group === "custom") chosen.add(f.id);
  return all.filter((f) => chosen.has(f.id));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 180_000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      signal: ac.signal,
      redirect: "follow",
      headers: { "user-agent": config.userAgent, ...(init.headers as Record<string, string>) },
    });
  } finally {
    clearTimeout(t);
  }
}

async function discoverUrl(def: FeedDef): Promise<string> {
  const d = def.discover!;
  const res = await fetchWithTimeout(d.page, {}, 60_000);
  if (!res.ok) throw new Error(`discovery page HTTP ${res.status}`);
  const html = (await res.text()).replace(/&amp;/g, "&");
  const re = new RegExp(d.pattern, "g");
  const matches = [...html.matchAll(re)];
  if (matches.length === 0) throw new Error("no feed link found on discovery page");
  const pick = d.pick ?? "first";
  if (pick === "last") return matches[matches.length - 1][0];
  if (pick === "covering") {
    const today = nowLocal().day;
    const dated = matches
      .filter((m) => m.groups?.from && m.groups?.to)
      .map((m) => ({ url: m[0], from: dayFromYmd(m.groups!.from), to: dayFromYmd(m.groups!.to) }));
    const covering = dated.filter((x) => x.from <= today && today <= x.to).sort((a, b) => b.from - a.from);
    if (covering.length) return covering[0].url;
    dated.sort((a, b) => b.from - a.from);
    if (dated.length) return dated[0].url;
  }
  return matches[0][0];
}

export function feedPaths(id: string) {
  const dir = join(config.cacheDir, "feeds");
  return { dir, zip: join(dir, `${id}.zip`), meta: join(dir, `${id}.meta.json`) };
}

export async function readMeta(id: string): Promise<FeedMeta | null> {
  try {
    return JSON.parse(await readFile(feedPaths(id).meta, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Make sure a fresh-enough copy of the feed is cached. Returns the zip path,
 * or null when the feed is unavailable and nothing is cached.
 * `changed` tells whether new data was downloaded.
 */
export async function ensureFeed(def: FeedDef, force = false): Promise<{ path: string | null; changed: boolean; error?: string }> {
  const p = feedPaths(def.id);
  await mkdir(p.dir, { recursive: true });
  const meta = await readMeta(def.id);
  const haveZip = existsSync(p.zip);
  const fresh = meta && haveZip && Date.now() - meta.checkedAt < config.refreshHours * 3600_000;
  if ((fresh && !force) || config.offline) {
    return { path: haveZip ? p.zip : null, changed: false, error: haveZip ? undefined : "offline and not cached" };
  }

  let urls: string[] = [];
  try {
    if (def.discover) urls.push(await discoverUrl(def));
  } catch (e) {
    log("warn", `${def.id}: discovery failed: ${(e as Error).message}`);
  }
  if (def.url) urls.push(def.url);
  urls.push(...(def.fallbackUrls ?? []));
  urls = [...new Set(urls)];
  if (urls.length === 0 && meta?.url) urls.push(meta.url);

  let lastErr = "no url";
  for (const url of urls) {
    try {
      const headers: Record<string, string> = {};
      if (meta && haveZip && meta.url === url) {
        if (meta.etag) headers["if-none-match"] = meta.etag;
        if (meta.lastModified) headers["if-modified-since"] = meta.lastModified;
      }
      log("info", `${def.id}: checking ${url}`);
      const res = await fetchWithTimeout(url, { headers });
      if (res.status === 304 && meta) {
        meta.checkedAt = Date.now();
        await writeFile(p.meta, JSON.stringify(meta, null, 2));
        return { path: p.zip, changed: false };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error("response is not a zip file");
      const tmp = p.zip + ".tmp";
      await writeFile(tmp, buf);
      await rename(tmp, p.zip);
      const newMeta: FeedMeta = {
        url,
        etag: res.headers.get("etag") ?? undefined,
        lastModified: res.headers.get("last-modified") ?? undefined,
        fetchedAt: Date.now(),
        checkedAt: Date.now(),
        size: buf.length,
      };
      await writeFile(p.meta, JSON.stringify(newMeta, null, 2));
      log("info", `${def.id}: downloaded ${(buf.length / 1e6).toFixed(1)} MB`);
      return { path: p.zip, changed: true };
    } catch (e) {
      lastErr = (e as Error).message;
      log("warn", `${def.id}: ${url} failed: ${lastErr}`);
    }
  }
  if (haveZip) {
    log("warn", `${def.id}: using cached copy (refresh failed: ${lastErr})`);
    return { path: p.zip, changed: false, error: lastErr };
  }
  return { path: null, changed: false, error: lastErr };
}

export async function zipMtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}
