import { config, log } from "./config.js";
import { normalize } from "./text.js";

/**
 * Railway disruptions (closures, replacement buses / ZKA, cancellations) from the
 * PKP PLK "Otwarte Dane Kolejowe" API: https://pdp-api.plk-sa.pl
 * Needs a free API key (ROZKLAD_PLK_API_KEY); without it this source is simply off.
 */
export interface Disruption {
  id: number;
  type: string;
  message: string;
  from?: string;
  to?: string;
  /** "orderId|YYYY-MM-DD" of affected train runs */
  runs: Set<string>;
  /** normalized names of affected stations (section ends + per-train stops) */
  stations: Set<string>;
}

interface Dto {
  generatedAt?: string;
  disruptions?: {
    disruptionId: number;
    disruptionTypeCode?: string;
    startStationId?: number;
    endStationId?: number;
    message?: string;
    affectedRoutes?: { scheduleId?: number; orderId?: number; trainOrderId?: number; operatingDate?: string; stationId?: number }[];
  }[];
  disruptionTypes?: Record<string, string>;
  stations?: Record<string, string>;
}

export const PLK_API = process.env.ROZKLAD_PLK_API_URL ?? "https://pdp-api.plk-sa.pl";
const TTL_SEC = 10 * 60;

export class PlkDisruptions {
  private key = process.env.ROZKLAD_PLK_API_KEY ?? "";
  private list: Disruption[] = [];
  private byRun = new Map<string, Disruption[]>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  generatedAt = "";
  lastError = "";

  get enabled(): boolean {
    return !!this.key && !config.offline;
  }

  get count(): number {
    return this.list.length;
  }

  async refresh(): Promise<void> {
    if (!this.enabled) return;
    if (this.fetchedAt && (Date.now() - this.fetchedAt) / 1000 < TTL_SEC) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const now = new Date();
        const ymd = (d: Date) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
        const url = `${PLK_API}/api/v1/disruptions?dateFrom=${ymd(now)}&dateTo=${ymd(new Date(now.getTime() + 2 * 86400_000))}`;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15_000);
        const res = await fetch(url, { signal: ac.signal, headers: { "x-api-key": this.key, "user-agent": config.userAgent, accept: "application/json" } });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.load((await res.json()) as Dto);
        this.lastError = "";
      } catch (e) {
        this.lastError = (e as Error).message;
        log("warn", `PLK disruptions unavailable: ${this.lastError}`);
      } finally {
        this.fetchedAt = Date.now();
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Index an API response (public for tests). */
  load(d: Dto) {
    const types = d.disruptionTypes ?? {};
    const st = d.stations ?? {};
    const name = (id?: number) => (id !== undefined ? st[String(id)] : undefined);
    const list: Disruption[] = [];
    const byRun = new Map<string, Disruption[]>();
    for (const x of d.disruptions ?? []) {
      // the API sometimes sends only a type code as the message ("utr_55")
      let message = (x.message ?? "").replace(/\s+/g, " ").trim();
      let code = x.disruptionTypeCode;
      if (/^utr_\d+$/.test(message)) {
        code = code ?? message;
        message = "";
      }
      const dis: Disruption = {
        id: x.disruptionId,
        type: (code && types[code]) || "Utrudnienie",
        message,
        from: name(x.startStationId),
        to: name(x.endStationId),
        runs: new Set(),
        stations: new Set(),
      };
      for (const s of [dis.from, dis.to]) if (s) dis.stations.add(normalize(s));
      for (const r of x.affectedRoutes ?? []) {
        const date = (r.operatingDate ?? "").slice(0, 10);
        for (const o of [r.orderId, r.trainOrderId]) {
          if (o === undefined || !date) continue;
          const k = `${o}|${date}`;
          if (dis.runs.has(k)) continue;
          dis.runs.add(k);
          let arr = byRun.get(k);
          if (!arr) byRun.set(k, (arr = []));
          arr.push(dis);
        }
        const sn = name(r.stationId);
        if (sn) dis.stations.add(normalize(sn));
      }
      list.push(dis);
    }
    this.list = list;
    this.byRun = byRun;
    this.generatedAt = d.generatedAt ?? "";
  }

  /** Disruptions of one train run. `tripId` = mkuran PLK trip id ("PLK_IC_2026_123456789[_LEG0]"). */
  forTrip(tripId: string, date: string): Disruption[] {
    const m = tripId.match(/_(\d+)(?:_LEG\d+)?$/);
    if (!m) return [];
    return this.byRun.get(`${m[1]}|${date}`) ?? [];
  }

  /** Disruptions touching a station name (normalized match) or containing the text. */
  search(query?: string): Disruption[] {
    if (!query) return this.list;
    const q = normalize(query);
    return this.list.filter((d) => [...d.stations].some((s) => s.includes(q)) || normalize(d.message).includes(q));
  }
}

export function shortMessage(d: Disruption, max = 220): string {
  const where = d.from && d.to && d.from !== d.to ? ` (${d.from} – ${d.to})` : d.from ? ` (${d.from})` : "";
  if (!d.message) return `${d.type}${where}`;
  const msg = d.message.length > max ? d.message.slice(0, max - 1) + "…" : d.message;
  return `${d.type}${where}: ${msg}`;
}
