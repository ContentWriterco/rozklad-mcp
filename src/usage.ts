import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { config, log } from "./config.js";

/**
 * Privacy-friendly usage counters for public instances (ROZKLAD_STATS=1).
 * Stored: per-day counts of tool calls by outcome, MCP client names, number of
 * distinct users (salted hashes kept in memory only, salt rotated daily and never
 * written), and place names that matched nothing (to improve search).
 * Not stored: IP addresses, coordinates, full queries, journeys.
 */
export type Outcome = "ok" | "no_result" | "not_found" | "ambiguous" | "user_error" | "error";

interface ToolDay {
  calls: number;
  ms: number;
  outcomes: Partial<Record<Outcome, number>>;
}
interface Day {
  date: string;
  tools: Record<string, ToolDay>;
  clients: Record<string, number>;
  users: number;
  rateLimited: number;
  notFound: Record<string, number>;
}

const KEEP_DAYS = 30;
const MAX_NOT_FOUND = 300;

export class Usage {
  readonly enabled = process.env.ROZKLAD_STATS === "1";
  private dir = join(config.cacheDir, "stats");
  private day: Day | null = null;
  private salt = randomBytes(16);
  private users = new Set<string>();
  private dirty = false;
  private timer?: NodeJS.Timeout;

  private today(): string {
    return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
  }

  private current(): Day {
    const date = this.today();
    if (this.day?.date === date) return this.day;
    if (this.day) void this.flushDay(this.day);
    this.salt = randomBytes(16);
    this.users.clear();
    let d: Day = { date, tools: {}, clients: {}, users: 0, rateLimited: 0, notFound: {} };
    try {
      d = { ...d, ...JSON.parse(readFileSync(join(this.dir, `${date}.json`), "utf8")) };
    } catch {
      /* new day */
    }
    this.day = d;
    void this.prune();
    return d;
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => void this.flush(), 5 * 60_000);
    this.timer.unref();
    const stop = () => void this.flush().finally(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }

  tool(name: string, outcome: Outcome, ms: number, notFound?: string) {
    if (!this.enabled) return;
    const d = this.current();
    const t = (d.tools[name] ??= { calls: 0, ms: 0, outcomes: {} });
    t.calls++;
    t.ms += Math.round(ms);
    t.outcomes[outcome] = (t.outcomes[outcome] ?? 0) + 1;
    if (notFound) {
      const q = notFound.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60);
      // never keep coordinates or anything that looks like an address number / phone
      if (q && !/\d{2,}/.test(q) && (d.notFound[q] !== undefined || Object.keys(d.notFound).length < MAX_NOT_FOUND)) {
        d.notFound[q] = (d.notFound[q] ?? 0) + 1;
      }
    }
    this.dirty = true;
  }

  request(ip: string, client?: string, limited = false) {
    if (!this.enabled) return;
    const d = this.current();
    const h = createHash("sha256").update(this.salt).update(ip).digest("base64").slice(0, 16);
    if (!this.users.has(h)) {
      this.users.add(h);
      d.users++;
    }
    if (client) {
      const c = client.toLowerCase().replace(/[^a-z0-9 ._-]/g, "").slice(0, 40) || "unknown";
      d.clients[c] = (d.clients[c] ?? 0) + 1;
    }
    if (limited) d.rateLimited++;
    this.dirty = true;
  }

  async flush() {
    if (!this.enabled || !this.day || !this.dirty) return;
    if (await this.flushDay(this.day)) this.dirty = false;
  }

  private async flushDay(d: Day): Promise<boolean> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, `${d.date}.json`), JSON.stringify(d));
      return true;
    } catch (e) {
      log("warn", `stats: ${(e as Error).message}`);
      return false;
    }
  }

  private async prune() {
    try {
      const cutoff = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
      for (const f of await readdir(this.dir)) if (f.endsWith(".json") && f.slice(0, 10) < cutoff) await rm(join(this.dir, f));
    } catch {
      /* no dir yet */
    }
  }

  /** Public summary (no place names). */
  async summary(days = 30): Promise<unknown> {
    this.current();
    await this.flush();
    const out: unknown[] = [];
    let files: string[] = [];
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith(".json")).sort().slice(-days);
    } catch {
      /* none */
    }
    for (const f of files) {
      try {
        const d = JSON.parse(await readFile(join(this.dir, f), "utf8")) as Day;
        const tools: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(d.tools)) tools[k] = { calls: v.calls, avg_ms: v.calls ? Math.round(v.ms / v.calls) : 0, outcomes: v.outcomes };
        out.push({ date: d.date, users: d.users, rate_limited: d.rateLimited, clients: d.clients, tools });
      } catch {
        /* skip */
      }
    }
    return {
      note: "Aggregated daily counts. No IP addresses, coordinates or queries are stored; users = distinct clients per day via a daily-rotated salted hash kept only in memory.",
      days: out,
    };
  }
}

export const usage = new Usage();

export function classify(text: string, isError: boolean, isUserError: boolean): Outcome {
  if (!isError) return /^No connection found|No departures in this window|^No stops (match|within)/m.test(text) ? "no_result" : "ok";
  if (!isUserError) return "error";
  if (/^No stop or station matches|^No stops within/.test(text)) return "not_found";
  if (/is ambiguous|matches places in different parts/.test(text)) return "ambiguous";
  return "user_error";
}
