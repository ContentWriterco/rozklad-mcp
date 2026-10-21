import { config, log } from "./config.js";
import { localParts, dayFromYmd, nowLocal, ymdFromDay } from "./time.js";
import { decodeTripUpdates } from "./gtfsrt.js";

/** Live state for one stop of a trip run. Delays in seconds. */
export interface LiveStop {
  seq: number;
  arrDelay?: number;
  depDelay?: number;
  cancelled?: boolean;
  confirmed?: boolean;
}

export interface LiveStopState {
  /** live times, seconds since the service day's midnight */
  arr?: number;
  dep?: number;
  /** or delays in seconds (GTFS-RT feeds that only send delays) */
  arrDelay?: number;
  depDelay?: number;
  cancelled?: boolean;
  confirmed?: boolean;
}

export interface LiveTrip {
  cancelled: boolean;
  detour: boolean;
  /** stop_sequence -> live */
  stops: Map<number, LiveStopState>;
  /** stop_id -> live (GTFS-RT feeds that identify stops by id) */
  byStop?: Map<string, LiveStopState>;
  /** trip-level delay (GTFS-RT TripUpdate.delay) */
  tripDelay?: number;
}

/** Common interface of live sources. */
export interface LiveSource {
  refresh(): Promise<void>;
  get(tripId: string, startDate: string, agencyId?: string, numbers?: string[]): LiveTrip | undefined;
  readonly available: boolean;
  feedTimestamp: string;
  lastError: string;
}

interface RawUpdate {
  trip_id: string;
  start_date: string;
  agency_id?: string;
  numbers?: string[];
  cancelled?: boolean;
  detour?: boolean;
  stop_times?: { stop_sequence: number; arrival?: string; departure?: string; cancelled?: boolean; confirmed?: boolean }[] | null;
}

/** Converts an RFC3339 instant to seconds since local midnight of `serviceDay`. */
function toServiceSecs(iso: string | undefined, serviceDay: number): number | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = localParts(d);
  return (p.day - serviceDay) * 86400 + p.secs;
}

/** Fetches and indexes the mkuran.pl "updates.json" live feed (Polish trains). */
export class MkuranLive implements LiveSource {
  private byTrip = new Map<string, LiveTrip>();
  private byNumber = new Map<string, LiveTrip>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  feedTimestamp = "";
  lastError = "";
  private etag = "";

  constructor(public url: string) {}

  ageSec(): number {
    return this.fetchedAt ? (Date.now() - this.fetchedAt) / 1000 : Infinity;
  }

  async refresh(): Promise<void> {
    if (!config.liveEnabled || config.offline) return;
    if (this.ageSec() < config.liveTtlSec) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 25_000);
        const headers: Record<string, string> = { "user-agent": config.userAgent };
        if (this.etag && this.byTrip.size) headers["if-none-match"] = this.etag;
        const res = await fetch(this.url, { signal: ac.signal, headers });
        clearTimeout(timer);
        if (res.status === 304) {
          this.fetchedAt = Date.now();
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.etag = res.headers.get("etag") ?? "";
        const data = (await res.json()) as { timestamp?: string; trip_updates?: RawUpdate[] | null };
        const byTrip = new Map<string, LiveTrip>();
        const byNumber = new Map<string, LiveTrip>();
        for (const u of data.trip_updates ?? []) {
          const sd = dayFromYmd(u.start_date);
          const stops = new Map<number, LiveStopState>();
          for (const st of u.stop_times ?? []) {
            stops.set(st.stop_sequence, {
              arr: toServiceSecs(st.arrival, sd),
              dep: toServiceSecs(st.departure, sd),
              cancelled: st.cancelled,
              confirmed: st.confirmed,
            });
          }
          const lt: LiveTrip = { cancelled: !!u.cancelled, detour: !!u.detour, stops };
          byTrip.set(`${u.trip_id}|${u.start_date}`, lt);
          for (const num of u.numbers ?? []) byNumber.set(`${u.agency_id}|${num}|${u.start_date}`, lt);
        }
        this.byTrip = byTrip;
        this.byNumber = byNumber;
        this.fetchedAt = Date.now();
        this.feedTimestamp = data.timestamp ?? "";
        this.lastError = "";
        log("debug", `live: ${byTrip.size} trip updates`);
      } catch (e) {
        this.lastError = (e as Error).message;
        log("warn", `live data unavailable: ${this.lastError}`);
        // keep stale data; retry after TTL
        this.fetchedAt = this.fetchedAt || 0;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  get(tripId: string, startDate: string, agencyId?: string, numbers?: string[]): LiveTrip | undefined {
    const t = this.byTrip.get(`${tripId}|${startDate}`);
    if (t) return t;
    for (const n of numbers ?? []) {
      const x = this.byNumber.get(`${agencyId}|${n}|${startDate}`);
      if (x) return x;
    }
    return undefined;
  }

  get available(): boolean {
    return this.byTrip.size > 0;
  }
}

/**
 * Standard GTFS-Realtime TripUpdates (protobuf), e.g. city transit.
 * Several URLs (e.g. bus + tram) are merged.
 */
export class GtfsRtLive implements LiveSource {
  private byTrip = new Map<string, LiveTrip>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  feedTimestamp = "";
  lastError = "";

  constructor(public urls: string[]) {}

  ageSec(): number {
    return this.fetchedAt ? (Date.now() - this.fetchedAt) / 1000 : Infinity;
  }

  async refresh(): Promise<void> {
    if (!config.liveEnabled || config.offline) return;
    if (this.ageSec() < Math.min(config.liveTtlSec, 60)) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const byTrip = new Map<string, LiveTrip>();
        let ts = 0;
        const errors: string[] = [];
        await Promise.all(
          this.urls.map(async (url) => {
            try {
              const ac = new AbortController();
              const timer = setTimeout(() => ac.abort(), 8_000);
              const res = await fetch(url, { signal: ac.signal, headers: { "user-agent": config.userAgent } });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const buf = new Uint8Array(await res.arrayBuffer());
              clearTimeout(timer);
              const feed = decodeTripUpdates(buf);
              ts = Math.max(ts, feed.timestamp ?? 0);
              const today = nowLocal().day;
              for (const tu of feed.trips) {
                const sd = tu.startDate ? dayFromYmd(tu.startDate) : today;
                const stops = new Map<number, LiveStopState>();
                const byStop = new Map<string, LiveStopState>();
                for (const u of tu.stops) {
                  const st: LiveStopState = {
                    arr: u.arrTime ? unixToServiceSecs(u.arrTime, sd) : undefined,
                    dep: u.depTime ? unixToServiceSecs(u.depTime, sd) : undefined,
                    arrDelay: u.arrDelay,
                    depDelay: u.depDelay,
                    cancelled: u.rel === 1 ? true : undefined,
                  };
                  if (u.rel === 2) continue; // NO_DATA
                  if (u.seq !== undefined) stops.set(u.seq, st);
                  if (u.stopId) byStop.set(u.stopId, st);
                }
                const lt: LiveTrip = { cancelled: tu.rel === 3 || tu.rel === 7, detour: false, stops, byStop, tripDelay: tu.delay };
                byTrip.set(`${tu.tripId}|${tu.startDate ? tu.startDate : "*"}`, lt);
              }
            } catch (e) {
              errors.push(`${new URL(url).host}: ${(e as Error).message}`);
            }
          }),
        );
        if (byTrip.size || !errors.length) {
          this.byTrip = byTrip;
          this.feedTimestamp = ts ? new Date(ts * 1000).toISOString() : "";
        }
        this.fetchedAt = Date.now();
        this.lastError = errors.join("; ");
        if (errors.length) log("warn", `live data: ${this.lastError}`);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  get(tripId: string, startDate: string): LiveTrip | undefined {
    const exact = this.byTrip.get(`${tripId}|${startDate.replace(/-/g, "")}`);
    if (exact) return exact;
    // feeds without start_date describe the current runs only
    if (startDate === ymdFromDay(nowLocal().day)) return this.byTrip.get(`${tripId}|*`);
    return undefined;
  }

  get available(): boolean {
    return this.byTrip.size > 0;
  }
}

function unixToServiceSecs(t: number, serviceDay: number): number {
  const p = localParts(new Date(t * 1000));
  return (p.day - serviceDay) * 86400 + p.secs;
}
