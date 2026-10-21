import { readFile } from "node:fs/promises";
import { config, log } from "./config.js";
import { ensureFeed, loadRegistry, selectFeeds, readMeta, type FeedDef } from "./feeds.js";
import { Network, MODE, MODE_NAMES, type Station } from "./network.js";
import { DayConnections, Router, journeyKey, type Endpoint, type Journey, type RideLeg } from "./router.js";
import { MkuranLive, type LiveTrip } from "./realtime.js";
import { matchScore, tokens, normalize } from "./text.js";
import { distM } from "./geo.js";
import { Fares, type FareQuote } from "./fares.js";
import { duration, hhmm, nowLocal, parseDateInput, parseTimeInput, prettyDate, ymdFromDay } from "./time.js";

const DAY = 86400;

export class UserError extends Error {}

export interface StationHit {
  index: number;
  station: Station;
  score: number;
  distance?: number;
}

function modeMaskFrom(modes?: string[]): number {
  if (!modes || modes.length === 0) return 0xff;
  let m = 0;
  for (const raw of modes) {
    const s = raw.toLowerCase();
    if (["train", "rail", "pociag", "pociąg", "kolej"].includes(s)) m |= MODE.rail;
    else if (["bus", "autobus", "pks", "coach"].includes(s)) m |= MODE.bus | MODE.trolleybus;
    else if (["tram", "tramwaj"].includes(s)) m |= MODE.tram;
    else if (["metro", "subway"].includes(s)) m |= MODE.metro;
    else if (["ferry", "prom"].includes(s)) m |= MODE.ferry;
    else if (s === "all") m |= 0xff;
  }
  return m || 0xff;
}

function modeList(mask: number): string {
  return Object.entries(MODE_NAMES)
    .filter(([bit]) => mask & Number(bit))
    .map(([, n]) => n)
    .join("/");
}

function fmtPln(v: number): string {
  return `${v.toFixed(2).replace(".", ",").replace(",00", "")} zł`;
}

function fmtRange(min: number, max: number | undefined): string {
  if (max === undefined || max === min) return fmtPln(min);
  return `${fmtPln(min).replace(" zł", "")}–${fmtPln(max)}`;
}

function fmtDelay(sec: number | undefined): string {
  if (sec === undefined) return "";
  const m = Math.round(sec / 60);
  if (m === 0) return "on time";
  return m > 0 ? `+${m} min` : `${m} min`;
}

export class Engine {
  net: Network | null = null;
  private loading: Promise<Network> | null = null;
  private defs: FeedDef[] = [];
  private live = new Map<string, MkuranLive>();
  fares = new Fares();
  private dayCache = new Map<string, DayConnections>();
  private router: Router | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  loadErrors: { id: string; error: string }[] = [];

  constructor() {
    this.defs = selectFeeds(loadRegistry());
    for (const d of this.defs) if (d.realtime?.type === "mkuran-json") this.live.set(d.id, new MkuranLive(d.realtime.url));
  }

  get feedDefs() {
    return this.defs;
  }

  /** Lazily download + parse all feeds. Concurrent callers share one load. */
  ready(): Promise<Network> {
    if (this.net) return Promise.resolve(this.net);
    if (!this.loading) {
      this.loading = this.build(false).then((net) => {
        this.net = net;
        this.router = new Router(net);
        this.scheduleRefresh();
        return net;
      });
      this.loading.catch(() => (this.loading = null));
    }
    return this.loading;
  }

  private async build(force: boolean): Promise<Network> {
    const t0 = Date.now();
    const net = new Network();
    const today = nowLocal().day;
    const errors: { id: string; error: string }[] = [];
    // download in parallel (bounded), parse sequentially
    const results = await Promise.all(this.defs.map((d) => ensureFeed(d, force).catch((e) => ({ path: null, changed: false, error: String(e) }))));
    for (let i = 0; i < this.defs.length; i++) {
      const def = this.defs[i];
      const r = results[i];
      if (!r.path) {
        errors.push({ id: def.id, error: r.error ?? "unavailable" });
        continue;
      }
      try {
        const t1 = Date.now();
        net.addFeed(def, new Uint8Array(await readFile(r.path)), today);
        log("info", `${def.id}: parsed in ${Date.now() - t1} ms`);
      } catch (e) {
        errors.push({ id: def.id, error: (e as Error).message });
        log("error", `${def.id}: failed to parse: ${(e as Error).message}`);
      }
    }
    if (net.feeds.length === 0) {
      throw new Error(`No timetable data could be loaded: ${errors.map((e) => `${e.id}: ${e.error}`).join("; ")}`);
    }
    net.finalize();
    this.loadErrors = errors;
    log("info", `loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return net;
  }

  private scheduleRefresh() {
    if (this.refreshTimer || config.offline) return;
    const ms = Math.max(1, config.refreshHours) * 3600_000;
    this.refreshTimer = setInterval(() => void this.refreshNow(false), ms);
    this.refreshTimer.unref();
  }

  /** Re-check feeds; rebuild the network in the background only if something changed. */
  async refreshNow(force: boolean): Promise<string> {
    const results = await Promise.all(this.defs.map((d) => ensureFeed(d, force).catch(() => ({ changed: false }))));
    const changed = results.some((r) => r.changed);
    if (!changed && this.net && !force) return "Timetables are up to date.";
    const net = await this.build(false);
    this.net = net;
    this.router = new Router(net);
    this.dayCache.clear();
    return "Timetables reloaded.";
  }

  private day(day: number, mask: number): DayConnections {
    const key = `${day}:${mask}`;
    let dc = this.dayCache.get(key);
    if (dc) {
      this.dayCache.delete(key);
      this.dayCache.set(key, dc);
      return dc;
    }
    const t0 = Date.now();
    dc = new DayConnections(this.net!, day, mask);
    log("debug", `connections for ${ymdFromDay(day)}: ${dc.count} in ${Date.now() - t0} ms`);
    this.dayCache.set(key, dc);
    while (this.dayCache.size > 4) this.dayCache.delete(this.dayCache.keys().next().value!);
    return dc;
  }

  // ---- stop search ---------------------------------------------------------

  search(query: string, limit = 10, modeMask = 0xff): StationHit[] {
    const net = this.net!;
    const q = tokens(query);
    if (q.length === 0) return [];
    const first = q[0].slice(0, 2);
    const hits: StationHit[] = [];
    for (let i = 0; i < net.stations.length; i++) {
      const st = net.stations[i];
      if (st.weight === 0 || (st.modes & modeMask) === 0) continue;
      // cheap prefilter (allow typos in later characters)
      if (!st.norm.includes(first) && q[0].length < 4) continue;
      const sc = matchScore(q, st.tokens);
      if (sc > 0) hits.push({ index: i, station: st, score: sc });
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        (b.station.modes & MODE.rail) - (a.station.modes & MODE.rail) ||
        b.station.weight - a.station.weight,
    );
    return hits.slice(0, limit);
  }

  nearby(lat: number, lon: number, radius: number, limit = 15, modeMask = 0xff): StationHit[] {
    const net = this.net!;
    const out: StationHit[] = [];
    for (let i = 0; i < net.stations.length; i++) {
      const st = net.stations[i];
      if (st.weight === 0 || (st.modes & modeMask) === 0) continue;
      const d = distM(lat, lon, st.lat, st.lon);
      if (d <= radius) out.push({ index: i, station: st, score: 0, distance: d });
    }
    out.sort((a, b) => a.distance! - b.distance!);
    return out.slice(0, limit);
  }

  /** Turn a user string (station, city, "lat,lon") into a routing endpoint. */
  resolve(input: string, role: "origin" | "destination" | "station", modeMask = 0xff): { endpoint: Endpoint; stations: number[]; note?: string } {
    const net = this.net!;
    const coord = input.match(/^\s*(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)\s*$/);
    if (coord) {
      const lat = +coord[1];
      const lon = +coord[2];
      const stops = new Map<number, number>();
      const stations = new Set<number>();
      for (let s = 0; s < net.stopCount; s++) {
        const d = distM(lat, lon, net.stopLat[s], net.stopLon[s]);
        if (d <= 1200) {
          stops.set(s, Math.round(60 + (d * 1.3) / 1.2));
          stations.add(net.stopStation[s]);
        }
      }
      if (stops.size === 0) throw new UserError(`No stops within 1.2 km of ${lat},${lon}. Try a larger town nearby or use find_stops.`);
      return { endpoint: { stops, label: `${lat.toFixed(5)},${lon.toFixed(5)}` }, stations: [...stations] };
    }

    const hits = this.search(input, 400, modeMask);
    if (hits.length === 0) {
      throw new UserError(`No stop or station matches "${input}". Use find_stops to look it up (try without the street, or the nearest town).`);
    }
    const qn = tokens(input).join(" ");
    let chosen: StationHit[];
    let note: string | undefined;
    const exact = hits.filter((h) => h.station.tokens.join(" ") === qn);
    const city = hits.filter((h) => h.score >= 85);
    if (exact.length && (city.length === 0 || role === "station")) {
      chosen = exact;
    } else if (exact.length || city.length) {
      // "Kraków" -> all stops whose name starts with "Kraków ..." (plus an exact one if present)
      chosen = [...exact, ...city]
        .sort((a, b) => b.station.weight - a.station.weight)
        .slice(0, role === "station" ? 1 : 60);
      if (role === "station" && !exact.length) {
        note = `"${input}" matches several stations; showing the busiest: ${chosen[0].station.name}. Others: ${city
          .slice(1, 8)
          .map((h) => h.station.name)
          .filter((n, i, a) => a.indexOf(n) === i)
          .join(", ")}.`;
      } else if (chosen.length > 1) {
        const names = [...new Set(chosen.map((h) => h.station.name))];
        note = `"${input}" treated as the whole town (${names.length} stations/stops, e.g. ${names.slice(0, 4).join(", ")}).`;
      }
    } else {
      const top = hits[0];
      const second = hits[1];
      if (!second || top.score - second.score >= 15 || (second.score === top.score && top.station.weight > 5 * second.station.weight)) {
        chosen = hits.filter((h) => h.station.norm === top.station.norm);
        if (top.score < 70) note = `Interpreted "${input}" as "${top.station.name}".`;
      } else {
        const cands = hits
          .slice(0, 10)
          .map((h) => `${h.station.name} (${modeList(h.station.modes)})`)
          .join("; ");
        throw new UserError(`"${input}" is ambiguous. Candidates: ${cands}. Pass the exact name.`);
      }
    }
    chosen = chosen.filter((h, i, a) => a.findIndex((x) => x.index === h.index) === i);
    chosen = this.checkSpread(input, chosen);
    if (note && new Set(chosen.map((h) => h.station.name)).size < 2 && role !== "station") note = undefined;
    const stops = new Map<number, number>();
    for (const h of chosen) for (const s of h.station.stops) stops.set(s, 0);
    const label = chosen.length === 1 || chosen.every((c) => c.station.norm === chosen[0].station.norm) ? chosen[0].station.name : input;
    return { endpoint: { stops, label }, stations: chosen.map((c) => c.index), note };
  }

  /**
   * Same-named places far apart (e.g. "Nowa Wieś") are different villages.
   * Keep the dominant cluster around the busiest station, or ask the user.
   */
  private checkSpread(input: string, chosen: StationHit[]): StationHit[] {
    if (chosen.length < 2) return chosen;
    const anchor = chosen.reduce((a, b) => (b.station.weight > a.station.weight ? b : a));
    const near = chosen.filter((h) => distM(anchor.station.lat, anchor.station.lon, h.station.lat, h.station.lon) <= 25000);
    if (near.length === chosen.length) return chosen;
    const wNear = near.reduce((s, h) => s + h.station.weight, 0);
    const wAll = chosen.reduce((s, h) => s + h.station.weight, 0);
    if (wNear >= 0.9 * wAll) return near;
    const seen = new Set<string>();
    const cands: string[] = [];
    for (const h of [...chosen].sort((a, b) => b.station.weight - a.station.weight)) {
      const key = `${h.station.name}|${Math.round(h.station.lat * 20)}|${Math.round(h.station.lon * 20)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cands.push(`${h.station.name} (${modeList(h.station.modes)}, ${h.station.lat.toFixed(3)},${h.station.lon.toFixed(3)})`);
      if (cands.length >= 10) break;
    }
    throw new UserError(
      `"${input}" matches places in different parts of Poland. Candidates: ${cands.join("; ")}. ` +
        `Pass the full station name, or "lat,lon" of the right one.`,
    );
  }

  // ---- live ----------------------------------------------------------------

  private liveFor(trip: number, serviceDay: number): LiveTrip | undefined {
    const net = this.net!;
    const feed = net.feeds[net.tripFeed[trip]].def;
    const lv = this.live.get(feed.id);
    if (!lv) return undefined;
    const route = net.tripRouteOf(trip);
    const nums = net.tripNumber[trip] ? net.tripNumber[trip].split(/[\/,\s]+/) : [];
    return lv.get(net.tripId[trip], ymdFromDay(serviceDay), route.agencyId, nums);
  }

  private async refreshLive(days: number[]): Promise<void> {
    const today = nowLocal().day;
    if (!days.some((d) => Math.abs(d - today) <= 1)) return;
    await Promise.all([...this.live.values()].map((l) => l.refresh()));
  }

  /** delay (s) at stop_time g for a trip run, using departure or arrival */
  private delayAt(lt: LiveTrip | undefined, g: number, which: "arr" | "dep"): { delay?: number; cancelled?: boolean } {
    if (!lt) return {};
    if (lt.cancelled) return { cancelled: true };
    const net = this.net!;
    const ls = lt.stops.get(net.stSeq.a[g]);
    if (!ls) return {};
    if (ls.cancelled) return { cancelled: true };
    const live = which === "dep" ? ls.dep ?? ls.arr : ls.arr ?? ls.dep;
    const sched = which === "dep" ? net.stDep.a[g] : net.stArr.a[g];
    if (live === undefined) return {};
    return { delay: live - sched };
  }

  // ---- formatting helpers --------------------------------------------------

  private platform(g: number): string {
    const net = this.net!;
    const raw = net.stPlatform.get(g) ?? net.stopPlatform[net.stStop.a[g]];
    if (!raw || /^(bus|\?)$/i.test(raw)) return "";
    const p = raw.replace(/^(peron|stanowisko|st\.?)\s*/i, "");
    const [plat, track] = p.split("/");
    if (track && plat && plat !== "?") return ` (platform ${plat}, track ${track})`;
    if (track) return ` (track ${track})`;
    return ` (platform ${plat})`;
  }

  /** For city-wide endpoints: other stops of the same run inside the origin/destination town. */
  private alsoCalls(leg: RideLeg, origin: Map<number, number>, dest: Map<number, number>, first: boolean, last: boolean): string {
    const net = this.net!;
    const parts: string[] = [];
    const s0 = net.tripStart.a[leg.trip];
    const end = s0 + net.tripLen.a[leg.trip];
    if (first && origin.size > 1) {
      const before: string[] = [];
      for (let g = s0; g < leg.boardSt; g++) {
        const st = net.stStop.a[g];
        if (origin.has(st) && origin.get(st) === 0 && !(net.stFlags.a[g] & 1)) before.push(`${net.stopName[st]} ${hhmm(net.stDep.a[g] + leg.offset)}`);
      }
      if (before.length) parts.push(`also boards earlier at: ${before.slice(-4).join(", ")}`);
    }
    if (last && dest.size > 1) {
      const after: string[] = [];
      for (let g = leg.alightSt + 1; g < end; g++) {
        const st = net.stStop.a[g];
        if (dest.has(st) && dest.get(st) === 0 && !(net.stFlags.a[g] & 2)) after.push(`${net.stopName[st]} ${hhmm(net.stArr.a[g] + leg.offset)}`);
      }
      if (after.length) parts.push(`continues to: ${after.slice(0, 4).join(", ")}`);
    }
    return parts.join(" · ");
  }

  private stopLabel(s: number): string {
    return this.net!.stopName[s];
  }

  private tripRef(trip: number, serviceDay: number): string {
    const net = this.net!;
    return `${net.feeds[net.tripFeed[trip]].def.id}:${net.tripId[trip]}@${ymdFromDay(serviceDay)}`;
  }

  private destinationOf(trip: number): string {
    const net = this.net!;
    const hs = net.tripHeadsign[trip];
    if (hs) return hs;
    const last = net.tripStart.a[trip] + net.tripLen.a[trip] - 1;
    return net.stopName[net.stStop.a[last]];
  }

  private sourcesFooter(feedIdx: Set<number>, usedLive: boolean): string {
    const net = this.net!;
    const parts = [...feedIdx].map((i) => net.feeds[i].def.attribution ?? net.feeds[i].def.name);
    if (usedLive) parts.push("live: PKP PLK S.A. via mkuran.pl (CC BY 4.0)");
    return `Data: ${[...new Set(parts)].join(" | ")}`;
  }

  // ---- tools ---------------------------------------------------------------

  async findStops(query: string, limit = 10, modes?: string[]): Promise<string> {
    await this.ready();
    const hits = this.search(query, limit, modeMaskFrom(modes));
    if (hits.length === 0) return `No stops match "${query}".`;
    return [
      `Stops matching "${query}":`,
      ...hits.map((h) => this.stationLine(h)),
      "",
      "Pass a name exactly as listed to plan_journey / departures. A bare town name (e.g. \"Kraków\") means all its stops.",
    ].join("\n");
  }

  private stationLine(h: StationHit): string {
    const net = this.net!;
    const st = h.station;
    const feeds = [...st.feeds].map((f) => net.feeds[f].def.id).join(",");
    const dist = h.distance !== undefined ? ` · ${Math.round(h.distance)} m` : "";
    return `- ${st.name} · ${modeList(st.modes)} · ${st.lat.toFixed(5)},${st.lon.toFixed(5)}${dist} · ${st.weight} stop-times · feeds: ${feeds}`;
  }

  async nearbyStops(lat: number, lon: number, radius = 800, modes?: string[]): Promise<string> {
    await this.ready();
    const hits = this.nearby(lat, lon, radius, 20, modeMaskFrom(modes));
    if (hits.length === 0) return `No stops within ${radius} m of ${lat},${lon}.`;
    return [`Stops near ${lat},${lon} (≤ ${radius} m):`, ...hits.map((h) => this.stationLine(h))].join("\n");
  }

  async plan(p: {
    from: string;
    to: string;
    date?: string;
    time?: string;
    arriveBy?: boolean;
    maxTransfers?: number;
    minTransferMinutes?: number;
    modes?: string[];
    results?: number;
    live?: boolean;
  }): Promise<string> {
    const net = await this.ready();
    const now = nowLocal();
    const day = parseDateInput(p.date, now.day);
    if (day === null) throw new UserError(`Cannot understand date "${p.date}". Use YYYY-MM-DD, "today" or "tomorrow".`);
    const defaultTime = day === now.day ? now.secs : 4 * 3600;
    const t = p.time ? parseTimeInput(p.time, now.secs) : defaultTime;
    if (t === null) throw new UserError(`Cannot understand time "${p.time}". Use HH:MM.`);
    const mask = modeMaskFrom(p.modes);
    const o = this.resolve(p.from, "origin", mask);
    const d = this.resolve(p.to, "destination", mask);
    if ([...o.endpoint.stops.keys()].some((s) => d.endpoint.stops.has(s))) {
      throw new UserError("Origin and destination are the same place.");
    }
    const results = Math.max(1, Math.min(10, p.results ?? 5));
    const opt = {
      maxTransfers: Math.max(0, Math.min(6, p.maxTransfers ?? 3)),
      minTransferSec: Math.round((p.minTransferMinutes ?? config.minTransferMin) * 60),
      horizonSec: 22 * 3600,
    };
    const tBuild = Date.now();
    const dc = this.day(day, mask);
    const router = this.router!;
    log("debug", `connections ready in ${Date.now() - tBuild} ms`);
    const found = new Map<string, Journey>();
    let start = p.arriveBy ? t - 10 * 3600 : t;
    const t0 = Date.now();
    for (let iter = 0; iter < 40; iter++) {
      const js = router.search(dc, o.endpoint, d.endpoint, start, opt);
      if (js.length === 0) break;
      for (const j of js) found.set(journeyKey(j), j);
      const firstRideDep = (j: Journey) => (j.legs.find((l) => l.kind === "ride") as RideLeg).dep;
      const minDep = Math.min(...js.map((j) => Math.max(j.dep, firstRideDep(j) - 3600)));
      start = minDep + 60;
      if (p.arriveBy) {
        if (minDep > t) break;
      } else if (found.size >= results * 2 || minDep > t + 6 * 3600) break;
      if (Date.now() - t0 > 8000) break;
    }
    log("debug", `search: ${found.size} journeys in ${Date.now() - t0} ms`);
    let list = [...found.values()];
    // drop dominated journeys
    list = list.filter(
      (j) =>
        !list.some(
          (k) =>
            k !== j && k.dep >= j.dep && k.arr <= j.arr && k.rides <= j.rides && (k.dep > j.dep || k.arr < j.arr || k.rides < j.rides),
        ),
    );
    list.sort((a, b) => a.dep - b.dep || a.arr - b.arr);
    if (p.arriveBy) list = list.filter((j) => j.arr <= t).slice(-results);
    else list = list.filter((j) => j.dep >= t - 60).slice(0, results);

    const header = [
      `${o.endpoint.label} → ${d.endpoint.label} · ${prettyDate(day)} · ${p.arriveBy ? "arrive by" : "depart after"} ${hhmm(t)}`,
    ];
    if (o.note) header.push(`Note: ${o.note}`);
    if (d.note) header.push(`Note: ${d.note}`);
    if (list.length === 0) {
      const validity = net.feeds.map((f) => `${f.def.id} ${ymdFromDay(f.validFrom)}…${ymdFromDay(f.validTo)}`).join(", ");
      return [
        ...header,
        "",
        `No connection found (max ${opt.maxTransfers} changes, modes: ${modeList(mask)}).`,
        "Try: more changes (max_transfers), a different time/date, a nearby bigger station, or enabling more feeds (ROZKLAD_FEEDS=trains,regional,city).",
        `Timetable coverage: ${validity}`,
      ].join("\n");
    }

    const useLive = p.live !== false && config.liveEnabled;
    if (useLive) await this.refreshLive([day]);
    const feedsUsed = new Set<number>();
    let usedLive = false;
    let priceSource: FareQuote | null = null;
    const lines: string[] = [...header, "Times local (Europe/Warsaw); (+1) = next day.", ""];
    list.forEach((j, idx) => {
      const rides = j.legs.filter((l): l is RideLeg => l.kind === "ride");
      const firstWalk = o.endpoint.stops.get(net.stStop.a[rides[0].boardSt]) ?? 0;
      const lastStop = j.legs[j.legs.length - 1].kind === "walk" ? (j.legs[j.legs.length - 1] as { to: number }).to : net.stStop.a[rides[rides.length - 1].alightSt];
      const lastWalk = d.endpoint.stops.get(lastStop) ?? 0;
      const depT = j.dep - firstWalk;
      const arrT = j.arr;
      const ch = j.rides - 1;
      lines.push(`${idx + 1}. ${hhmm(depT)} → ${hhmm(arrT)} · ${duration(arrT - depT)} · ${ch === 0 ? "direct" : `${ch} change${ch > 1 ? "s" : ""}`}`);
      if (firstWalk > 0) lines.push(`   walk ${duration(firstWalk)} to ${this.stopLabel(net.stStop.a[rides[0].boardSt])}`);
      for (const leg of j.legs) {
        if (leg.kind === "walk") {
          const fromSt = net.stationOfStop(leg.from).name;
          const toName = net.stopName[leg.to];
          const w = net.walkTime(leg.from, leg.to);
          if (leg.from === leg.to || w === 0) lines.push(`   change at ${fromSt}`);
          else lines.push(`   walk ${duration(w)} to ${toName}`);
          continue;
        }
        const trip = leg.trip;
        feedsUsed.add(net.tripFeed[trip]);
        const route = net.tripRouteOf(trip);
        const serviceDay = day + leg.offset / DAY;
        let liveTxt = "";
        if (useLive) {
          const lt = this.liveFor(trip, serviceDay);
          if (lt) {
            usedLive = true;
            const b = this.delayAt(lt, leg.boardSt, "dep");
            const a = this.delayAt(lt, leg.alightSt, "arr");
            if (b.cancelled || a.cancelled) liveTxt = " · ⚠ CANCELLED (live)";
            else if (b.delay !== undefined || a.delay !== undefined)
              liveTxt = ` · live: dep ${fmtDelay(b.delay) || "?"}, arr ${fmtDelay(a.delay) || "?"}`;
            if (lt.detour) liveTxt += " · detour";
          }
        }
        const also = this.alsoCalls(leg, o.endpoint.stops, d.endpoint.stops, leg === rides[0], leg === rides[rides.length - 1]);
        lines.push(
          `   ${net.tripLabel(trip)} (${route.agency}) → ${this.destinationOf(trip)}`,
          `     ${hhmm(leg.dep)} ${this.stopLabel(net.stStop.a[leg.boardSt])}${this.platform(leg.boardSt)} → ${hhmm(leg.arr)} ${this.stopLabel(net.stStop.a[leg.alightSt])}${this.platform(leg.alightSt)}${liveTxt}`,
          ...(also ? [`     ${also}`] : []),
        );
        const q = this.priceForRide(trip, leg.boardSt, leg.alightSt);
        if (q) {
          priceSource = q;
          lines.push(`     price list (max): ${fmtRange(q.class2, q.class2Max)} 2nd class / ${fmtRange(q.class1, q.class1Max)} 1st class${q.basis.endsWith("km") ? ` · ${q.basis}` : ""} · often cheaper in sale`);
        }
        lines.push(`     ref: ${this.tripRef(trip, serviceDay)}`);
      }
      if (lastWalk > 0) lines.push(`   walk ${duration(lastWalk)} to destination`);
    });
    lines.push("", "Tickets are not sold here - check the carrier. Use trip_details with a ref for all stops.");
    if (priceSource) {
      const ps = priceSource as FareQuote;
      lines.push(
        `Prices: ${ps.carrier} published price list valid from ${ps.validFrom} - maximum base price of a full-fare single ticket per train, before discounts and promotions; the price in sale is often lower. Source: ${ps.source}`,
      );
    }
    lines.push(this.sourcesFooter(feedsUsed, usedLive));
    return lines.join("\n");
  }

  /** Price-list quote for one ride (currently PKP Intercity), or null. */
  priceForRide(trip: number, boardSt: number, alightSt: number): FareQuote | null {
    const net = this.net!;
    if (!this.fares.loaded) return null;
    const route = net.tripRouteOf(trip);
    const s0 = net.tripStart.a[trip];
    const dist = net.tripDistKm.get(trip);
    const km = dist ? dist[alightSt - s0] - dist[boardSt - s0] : null;
    const names: string[] = [];
    for (let g = boardSt; g <= alightSt; g++) names.push(net.stopName[net.stStop.a[g]]);
    return this.fares.quote(route.agencyId, route.shortName, km, names);
  }

  async departures(p: {
    station: string;
    date?: string;
    time?: string;
    durationMinutes?: number;
    direction?: string;
    modes?: string[];
    arrivals?: boolean;
    limit?: number;
    live?: boolean;
  }): Promise<string> {
    const net = await this.ready();
    const now = nowLocal();
    const day = parseDateInput(p.date, now.day);
    if (day === null) throw new UserError(`Cannot understand date "${p.date}".`);
    const t = p.time ? parseTimeInput(p.time, now.secs) : day === now.day ? now.secs : 0;
    if (t === null) throw new UserError(`Cannot understand time "${p.time}".`);
    const mask = modeMaskFrom(p.modes);
    const r = this.resolve(p.station, "station", mask);
    const stopsAt = new Set(r.endpoint.stops.keys());
    const window = Math.max(10, Math.min(24 * 60, p.durationMinutes ?? 120)) * 60;
    const limit = Math.max(1, Math.min(100, p.limit ?? 30));
    let dirTokens: string[] | null = null;
    if (p.direction) dirTokens = tokens(p.direction);

    type Row = { time: number; trip: number; g: number; serviceDay: number };
    const rows: Row[] = [];
    const tStart = net.tripStart.a;
    const tLen = net.tripLen.a;
    const sStop = net.stStop.a;
    for (let trip = 0; trip < net.tripCount; trip++) {
      const len = tLen[trip];
      if (len < 2) continue;
      if ((net.tripRouteOf(trip).mode & mask) === 0) continue;
      const s0 = tStart[trip];
      for (const off of [-1, 0]) {
        const sd = day + off;
        if (!net.isActive(trip, sd)) continue;
        for (let k = 0; k < len; k++) {
          const g = s0 + k;
          if (!stopsAt.has(sStop[g])) continue;
          if (!p.arrivals && k === len - 1) continue;
          if (p.arrivals && k === 0) continue;
          const tt = (p.arrivals ? net.stArr.a[g] : net.stDep.a[g]) + off * DAY;
          if (tt < t || tt > t + window) continue;
          if (dirTokens) {
            const range = p.arrivals ? [s0, g] : [g + 1, s0 + len];
            let ok = false;
            for (let m = range[0]; m < range[1] && !ok; m++) {
              if (matchScore(dirTokens, net.stationOfStop(sStop[m]).tokens) >= 55) ok = true;
            }
            if (!ok) continue;
          }
          rows.push({ time: tt, trip, g, serviceDay: sd });
        }
      }
    }
    rows.sort((a, b) => a.time - b.time);
    // collapse identical runs (some feeds model one bus as several trips)
    const seenRow = new Set<string>();
    const uniq = rows.filter((r) => {
      const k = `${r.time}|${net.tripLabel(r.trip)}|${net.stStop.a[r.g]}|${this.destinationOf(r.trip)}`;
      if (seenRow.has(k)) return false;
      seenRow.add(k);
      return true;
    });
    rows.length = 0;
    rows.push(...uniq);
    const shown = rows.slice(0, limit);
    const useLive = p.live !== false && config.liveEnabled;
    if (useLive && shown.length) await this.refreshLive([day]);
    const feedsUsed = new Set<number>();
    let usedLive = false;
    const lines = [
      `${p.arrivals ? "Arrivals at" : "Departures from"} ${r.endpoint.label} · ${prettyDate(day)} · ${hhmm(t)}–${hhmm(t + window)}${p.direction ? ` · towards "${p.direction}"` : ""}`,
    ];
    if (r.note) lines.push(`Note: ${r.note}`);
    lines.push("");
    if (shown.length === 0) lines.push("No departures in this window. Try a longer duration_minutes or another date.");
    for (const row of shown) {
      const trip = row.trip;
      feedsUsed.add(net.tripFeed[trip]);
      const route = net.tripRouteOf(trip);
      let liveTxt = "";
      if (useLive) {
        const lt = this.liveFor(trip, row.serviceDay);
        if (lt) {
          usedLive = true;
          const dl = this.delayAt(lt, row.g, p.arrivals ? "arr" : "dep");
          liveTxt = dl.cancelled ? " ⚠ CANCELLED" : dl.delay !== undefined ? ` [${fmtDelay(dl.delay)}]` : "";
        }
      }
      let other: string;
      if (p.arrivals) {
        other = `from ${net.stopName[net.stStop.a[net.tripStart.a[trip]]]}`;
      } else {
        // a few upcoming stops help the agent judge direction
        const s0 = net.tripStart.a[trip];
        const end = s0 + net.tripLen.a[trip];
        const vias: string[] = [];
        const step = Math.max(1, Math.floor((end - row.g - 1) / 4));
        for (let m = row.g + step; m < end - 1 && vias.length < 3; m += step) vias.push(net.stopName[net.stStop.a[m]]);
        other = `→ ${this.destinationOf(trip)}${vias.length ? ` (via ${vias.join(", ")})` : ""}`;
      }
      const stopName = stopsAt.size > 1 && r.stations.length > 1 ? ` @ ${net.stopName[net.stStop.a[row.g]]}` : "";
      lines.push(
        `${hhmm(row.time)}${liveTxt} ${net.tripLabel(trip)}${this.platform(row.g)}${stopName} ${other} · ${route.agency} · ref ${this.tripRef(trip, row.serviceDay)}`,
      );
    }
    if (rows.length > shown.length) lines.push(`… ${rows.length - shown.length} more (raise limit or narrow the window).`);
    lines.push("", this.sourcesFooter(feedsUsed, usedLive));
    return lines.join("\n");
  }

  async tripDetails(p: { ref?: string; train?: string; date?: string; live?: boolean }): Promise<string> {
    const net = await this.ready();
    const now = nowLocal();
    let runs: { trip: number; serviceDay: number }[] = [];
    if (p.ref) {
      const m = p.ref.match(/^([^:]+):(.+)@(\d{4}-\d{2}-\d{2})$/);
      if (!m) throw new UserError(`Bad ref "${p.ref}". Use a ref returned by plan_journey or departures.`);
      const feedIdx = net.feeds.findIndex((f) => f.def.id === m[1]);
      const trip = net.tripId.findIndex((id, i) => id === m[2] && net.tripFeed[i] === feedIdx);
      if (trip < 0) throw new UserError(`Trip ${p.ref} not found (timetable may have been refreshed - search again).`);
      runs = [{ trip, serviceDay: parseDateInput(m[3], now.day)! }];
    } else if (p.train) {
      const day = parseDateInput(p.date, now.day);
      if (day === null) throw new UserError(`Cannot understand date "${p.date}".`);
      const raw = p.train.trim();
      const numMatch = raw.match(/\d{2,6}/);
      const keys = new Set<string>();
      if (numMatch) keys.add(numMatch[0]);
      keys.add(normalize(raw.replace(/^(ic|tlk|eip|eic|ex|ec|en|ir|r|os|km|kd|ks|kw|ar|rj|le|ska|skm|lka|kml)\s+/i, "")));
      const cands = new Set<number>();
      for (const k of keys) for (const t of net.numberIndex.get(k) ?? []) cands.add(t);
      for (const t of cands) for (const off of [0, -1]) if (net.isActive(t, day + off)) {
        // a run from yesterday counts only if it is still running past midnight
        if (off === -1 && net.stArr.a[net.tripStart.a[t] + net.tripLen.a[t] - 1] < DAY) continue;
        runs.push({ trip: t, serviceDay: day + off });
      }
      if (runs.length === 0) {
        if (cands.size) throw new UserError(`Train "${p.train}" exists but does not run on ${ymdFromDay(day)}.`);
        throw new UserError(`No train "${p.train}" found. Use the number (e.g. 3510) or a ref from departures.`);
      }
      // prefer category match if the user typed one (e.g. "IC 3510")
      const cat = raw.match(/^([a-z]+)\s/i)?.[1]?.toUpperCase();
      if (cat && runs.length > 1) {
        const f = runs.filter((r) => net.tripRouteOf(r.trip).shortName.toUpperCase() === cat);
        if (f.length) runs = f;
      }
    } else throw new UserError("Pass either ref or train.");

    const useLive = p.live !== false && config.liveEnabled;
    if (useLive) await this.refreshLive(runs.map((r) => r.serviceDay));
    const out: string[] = [];
    const feedsUsed = new Set<number>();
    let usedLive = false;
    for (const run of runs.slice(0, 3)) {
      const trip = run.trip;
      feedsUsed.add(net.tripFeed[trip]);
      const route = net.tripRouteOf(trip);
      const lt = useLive ? this.liveFor(trip, run.serviceDay) : undefined;
      if (lt) usedLive = true;
      out.push(
        `${net.tripLabel(trip)} · ${route.agency}${route.longName ? ` · ${route.longName}` : ""} · ${prettyDate(run.serviceDay)}`,
        `→ ${this.destinationOf(trip)}${lt?.cancelled ? " · ⚠ CANCELLED (live)" : ""}${lt?.detour ? " · ⚠ on detour" : ""}${
          useLive && this.live.has(net.feeds[net.tripFeed[trip]].def.id) && !lt ? " · no live data for this run" : ""
        }`,
      );
      const s0 = net.tripStart.a[trip];
      const len = net.tripLen.a[trip];
      for (let k = 0; k < len; k++) {
        const g = s0 + k;
        const a = net.stArr.a[g];
        const dd = net.stDep.a[g];
        const times = k === 0 ? `      ${hhmm(dd)}` : k === len - 1 ? `${hhmm(a)}      ` : a === dd ? `      ${hhmm(dd)}` : `${hhmm(a)} ${hhmm(dd)}`;
        let liveTxt = "";
        if (lt) {
          const dl = this.delayAt(lt, g, k === len - 1 ? "arr" : "dep");
          if (dl.cancelled) liveTxt = " ⚠ cancelled";
          else if (dl.delay !== undefined) liveTxt = ` [${fmtDelay(dl.delay)}${lt.stops.get(net.stSeq.a[g])?.confirmed ? ", passed" : ""}]`;
        }
        const flags = net.stFlags.a[g];
        const req = flags & 1 && flags & 2 ? " (no stop)" : flags & 1 ? " (alight only)" : flags & 2 ? " (board only)" : "";
        out.push(`  ${times}  ${net.stopName[net.stStop.a[g]]}${this.platform(g)}${req}${liveTxt}`);
      }
      out.push(`  ref: ${this.tripRef(trip, run.serviceDay)}`, "");
    }
    if (runs.length > 3) out.push(`(${runs.length - 3} more runs match - be more specific)`);
    out.push(this.sourcesFooter(feedsUsed, usedLive));
    return out.join("\n");
  }

  async sources(): Promise<string> {
    const lines = ["Timetable sources (open data):", ""];
    const net = this.net;
    for (const def of this.defs) {
      const meta = await readMeta(def.id);
      const fi = net?.feeds.find((f) => f.def.id === def.id);
      const err = this.loadErrors.find((e) => e.id === def.id);
      const status = fi
        ? `loaded · valid ${ymdFromDay(fi.validFrom)}…${ymdFromDay(fi.validTo)} · ${fi.stats.trips} trips`
        : err
          ? `NOT loaded (${err.error})`
          : net
            ? "not loaded"
            : "not loaded yet (loads on first query)";
      lines.push(
        `- ${def.id} [${def.group}${def.city ? `: ${def.city}` : ""}] ${def.name}`,
        `  ${status}${meta ? ` · downloaded ${new Date(meta.fetchedAt).toISOString().slice(0, 16)}Z` : ""}${def.realtime ? " · live delays" : ""}`,
        `  license: ${def.license ?? "?"} · attribution: ${def.attribution ?? def.name}`,
      );
    }
    const all = loadRegistry();
    const off = all.filter((f) => !this.defs.some((d) => d.id === f.id));
    if (off.length) {
      lines.push("", `Available but not enabled (set ROZKLAD_FEEDS, e.g. "trains,regional,city:Poznań"):`);
      lines.push(off.map((f) => `${f.id}${f.city ? ` (${f.city})` : ""}`).join(", "));
    }
    for (const [id, lv] of this.live) {
      lines.push("", `Live (${id}): ${lv.available ? `updated ${lv.feedTimestamp}` : lv.lastError ? `error: ${lv.lastError}` : "fetched on demand"}`);
    }
    return lines.join("\n");
  }
}
