import { unzipSync, Unzip, UnzipInflate } from "fflate";
import { parseCsv, CsvStream, type ColFn } from "./csv.js";
import { GrowI32, GrowF64, GrowU8 } from "./grow.js";
import { distM, GridIndex } from "./geo.js";
import { normalize, tokens, stationGroupName } from "./text.js";
import { dayFromYmd, weekday } from "./time.js";
import type { FeedDef } from "./feeds.js";
import { config, log } from "./config.js";

export const MODE = { rail: 1, bus: 2, tram: 4, metro: 8, ferry: 16, trolleybus: 32, other: 64 } as const;
export const MODE_NAMES: Record<number, string> = { 1: "train", 2: "bus", 4: "tram", 8: "metro", 16: "ferry", 32: "trolleybus", 64: "other" };

export function modeFromRouteType(t: number): number {
  if (t === 2 || (t >= 100 && t < 200)) return MODE.rail;
  if (t === 3 || (t >= 200 && t < 300) || (t >= 700 && t < 800)) return MODE.bus;
  if (t === 0 || (t >= 900 && t < 1000)) return MODE.tram;
  if (t === 1 || (t >= 400 && t < 500)) return MODE.metro;
  if (t === 4 || (t >= 1000 && t < 1300)) return MODE.ferry;
  if (t === 11 || t === 800) return MODE.trolleybus;
  return MODE.other;
}

export interface Route {
  id: string;
  shortName: string;
  longName: string;
  mode: number;
  agency: string;
  agencyId: string;
  feed: number;
}

export interface Station {
  name: string;
  lat: number;
  lon: number;
  stops: number[];
  feeds: Set<number>;
  modes: number;
  tokens: string[];
  norm: string;
  weight: number;
}

export interface FeedInfo {
  def: FeedDef;
  validFrom: number;
  validTo: number;
  agencies: string[];
  stats: { stops: number; trips: number; stopTimes: number };
  loadedAt: number;
}

const FLAG_NO_PICKUP = 1;
const FLAG_NO_DROPOFF = 2;
export { FLAG_NO_PICKUP, FLAG_NO_DROPOFF };

/** Window of calendar days kept in memory (relative to today). */
const CAL_PAST = 3;
const CAL_FUTURE = 400;

/**
 * The combined multi-feed timetable. All ids are global indices.
 * Stop times of each trip are stored contiguously.
 */
export class Network {
  feeds: FeedInfo[] = [];
  routes: Route[] = [];

  stopId: string[] = [];
  stopName: string[] = [];
  stopPlatform: (string | undefined)[] = [];
  stopFeed: number[] = [];
  stopStation: number[] = [];
  private lat = new GrowF64();
  private lon = new GrowF64();
  stopLat!: Float64Array;
  stopLon!: Float64Array;

  stations: Station[] = [];

  tripId: string[] = [];
  tripRoute = new GrowI32();
  tripService = new GrowI32();
  tripStart = new GrowI32();
  tripLen = new GrowI32();
  tripShort: string[] = [];
  tripHeadsign: string[] = [];
  tripNumber: string[] = [];
  tripName: string[] = [];
  tripFeed: number[] = [];

  stStop = new GrowI32(1 << 16);
  stArr = new GrowI32(1 << 16);
  stDep = new GrowI32(1 << 16);
  stSeq = new GrowI32(1 << 16);
  stFlags = new GrowU8(1 << 16);
  /** Platform/track per stop_time (sparse). */
  stPlatform = new Map<number, string>();

  /** service global index -> active day numbers */
  serviceDays: Set<number>[] = [];

  /** normalized train number / name -> trip indices */
  numberIndex = new Map<string, number[]>();

  // Footpaths in CSR format (built in finalize)
  fpStart!: Int32Array;
  fpTo!: Int32Array;
  fpDur!: Int32Array;

  /** stop -> station-level trip departures count (importance) */
  finalized = false;

  get stopCount() {
    return this.stopId.length;
  }
  get tripCount() {
    return this.tripId.length;
  }

  // ---- ingestion -----------------------------------------------------------

  addFeed(def: FeedDef, zip: Uint8Array, today: number): void {
    const feedIdx = this.feeds.length;
    const wanted = new Set([
      "agency.txt",
      "stops.txt",
      "routes.txt",
      "trips.txt",
      "calendar.txt",
      "calendar_dates.txt",
      "feed_info.txt",
    ]);
    const base = (n: string) => n.split("/").pop()!;
    // small files in one go; stop_times.txt is streamed later (can be > 500 MB)
    const files = unzipSync(zip, { filter: (f) => wanted.has(base(f.name)) });
    const decoder = new TextDecoder("utf-8");
    const get = (name: string): string | null => {
      for (const k of Object.keys(files)) if (base(k) === name) return decoder.decode(files[k]);
      return null;
    };
    const must = (name: string) => {
      const t = get(name);
      if (t === null) throw new Error(`${def.id}: missing ${name}`);
      return t;
    };

    // agencies
    const agencies = new Map<string, string>();
    const agencyText = get("agency.txt");
    if (agencyText) {
      parseCsv(agencyText).forEach((r, c) => {
        agencies.set(r[c("agency_id")] ?? "", r[c("agency_name")] ?? "");
      });
    }
    const firstAgency = agencies.size ? [...agencies.values()][0] : def.name;

    // routes
    const routeIdx = new Map<string, number>();
    parseCsv(must("routes.txt")).forEach((r, c) => {
      const id = r[c("route_id")];
      const agencyId = c("agency_id") >= 0 ? r[c("agency_id")] : "";
      routeIdx.set(id, this.routes.length);
      this.routes.push({
        id,
        shortName: (r[c("route_short_name")] ?? "").trim(),
        longName: (r[c("route_long_name")] ?? "").trim(),
        mode: modeFromRouteType(Number(r[c("route_type")] ?? 3)),
        agency: agencies.get(agencyId) ?? firstAgency,
        agencyId,
        feed: feedIdx,
      });
    });

    // stops
    const stopIdx = new Map<string, number>();
    const parentOf: [number, string][] = [];
    const parentStations = new Map<string, { name: string; lat: number; lon: number }>();
    const firstStop = this.stopCount;
    parseCsv(must("stops.txt")).forEach((r, c) => {
      const lt = Number(r[c("location_type")] || 0);
      const id = r[c("stop_id")];
      const name = (r[c("stop_name")] ?? "").trim();
      const lat = Number(r[c("stop_lat")]);
      const lon = Number(r[c("stop_lon")]);
      if (lt === 1) {
        parentStations.set(id, { name, lat, lon });
        return;
      }
      if (lt !== 0) return;
      const gi = this.stopCount;
      stopIdx.set(id, gi);
      this.stopId.push(`${def.id}:${id}`);
      this.stopName.push(name);
      const pc = c("platform_code") >= 0 ? r[c("platform_code")] : "";
      this.stopPlatform.push(pc || undefined);
      this.stopFeed.push(feedIdx);
      this.stopStation.push(-1);
      this.lat.push(lat);
      this.lon.push(lon);
      const parent = c("parent_station") >= 0 ? r[c("parent_station")] : "";
      if (parent && parent !== "0") parentOf.push([gi, parent]);
    });

    // stations: explicit parents first
    const parentStationIdx = new Map<string, number>();
    for (const [gi, p] of parentOf) {
      const ps = parentStations.get(p);
      if (!ps) continue;
      let si = parentStationIdx.get(p);
      if (si === undefined) {
        si = this.newStation(ps.name, ps.lat, ps.lon, feedIdx);
        parentStationIdx.set(p, si);
      }
      this.attachStop(gi, si);
    }
    // orphan stops: group by name (minus post numbers) within ~400 m
    const groups = new Map<string, number[]>();
    for (let gi = firstStop; gi < this.stopCount; gi++) {
      if (this.stopStation[gi] !== -1) continue;
      const key = normalize(stationGroupName(this.stopName[gi])) || normalize(this.stopName[gi]);
      const lat = this.lat.a[gi];
      const lon = this.lon.a[gi];
      let cands = groups.get(key);
      if (!cands) groups.set(key, (cands = []));
      let joined = false;
      for (const si of cands) {
        const s = this.stations[si];
        if (distM(lat, lon, s.lat, s.lon) <= 400) {
          this.attachStop(gi, si);
          joined = true;
          break;
        }
      }
      if (!joined) {
        const si = this.newStation(stationGroupName(this.stopName[gi]) || this.stopName[gi], lat, lon, feedIdx);
        this.attachStop(gi, si);
        cands.push(si);
      }
    }

    // calendars
    const serviceIdx = new Map<string, number>();
    const svc = (id: string) => {
      let i = serviceIdx.get(id);
      if (i === undefined) {
        i = this.serviceDays.length;
        this.serviceDays.push(new Set());
        serviceIdx.set(id, i);
      }
      return i;
    };
    const minDay = today - CAL_PAST;
    const maxDay = today + CAL_FUTURE;
    let validFrom = Infinity;
    let validTo = -Infinity;
    const calText = get("calendar.txt");
    if (calText) {
      parseCsv(calText).forEach((r, c) => {
        const set = this.serviceDays[svc(r[c("service_id")])];
        const wd = [
          r[c("sunday")] === "1",
          r[c("monday")] === "1",
          r[c("tuesday")] === "1",
          r[c("wednesday")] === "1",
          r[c("thursday")] === "1",
          r[c("friday")] === "1",
          r[c("saturday")] === "1",
        ];
        if (!wd.some(Boolean)) return;
        const from = Math.max(dayFromYmd(r[c("start_date")]), minDay);
        const to = Math.min(dayFromYmd(r[c("end_date")]), maxDay);
        for (let d = from; d <= to; d++) if (wd[weekday(d)]) set.add(d);
      });
    }
    const cdText = get("calendar_dates.txt");
    if (cdText) {
      parseCsv(cdText).forEach((r, c) => {
        const d = dayFromYmd(r[c("date")]);
        if (d < minDay || d > maxDay) {
          // still register the service id so trips resolve
          svc(r[c("service_id")]);
          return;
        }
        const set = this.serviceDays[svc(r[c("service_id")])];
        if (r[c("exception_type")] === "2") set.delete(d);
        else set.add(d);
      });
    }
    for (const id of serviceIdx.values()) {
      for (const d of this.serviceDays[id]) {
        if (d < validFrom) validFrom = d;
        if (d > validTo) validTo = d;
      }
    }

    // trips
    const tripIdx = new Map<string, number>();
    const firstTrip = this.tripCount;
    parseCsv(must("trips.txt")).forEach((r, c) => {
      const ri = routeIdx.get(r[c("route_id")]);
      if (ri === undefined) return;
      const id = r[c("trip_id")];
      tripIdx.set(id, this.tripCount);
      this.tripId.push(id);
      this.tripRoute.push(ri);
      this.tripService.push(svc(r[c("service_id")]));
      this.tripStart.push(0);
      this.tripLen.push(0);
      const short = (c("trip_short_name") >= 0 ? r[c("trip_short_name")] : "") || "";
      const plkNum = c("plk_train_number") >= 0 ? r[c("plk_train_number")] : "";
      this.tripShort.push(short);
      this.tripNumber.push(plkNum || short);
      this.tripName.push(c("plk_train_name") >= 0 ? r[c("plk_train_name")] || "" : "");
      this.tripHeadsign.push((c("trip_headsign") >= 0 ? r[c("trip_headsign")] : "") || "");
      this.tripFeed.push(feedIdx);
    });

    // stop_times -> temp arrays (streamed), then order by (trip, seq)
    const tTrip = new GrowI32(1 << 16);
    const tSeq = new GrowI32(1 << 16);
    const tStop = new GrowI32(1 << 16);
    const tArr = new GrowI32(1 << 16);
    const tDep = new GrowI32(1 << 16);
    const tFlags = new GrowU8(1 << 16);
    const tPlat = new Map<number, string>();
    let cols: { trip: number; stop: number; seq: number; arr: number; dep: number; pu: number; dropOff: number; plat: number; track: number } | null = null;
    const onRow = (r: string[], c: ColFn) => {
      if (!cols)
        cols = {
          trip: c("trip_id"),
          stop: c("stop_id"),
          seq: c("stop_sequence"),
          arr: c("arrival_time"),
          dep: c("departure_time"),
          pu: c("pickup_type"),
          dropOff: c("drop_off_type"),
          plat: c("platform"),
          track: c("track"),
        };
      const ti = tripIdx.get(r[cols.trip]);
      if (ti === undefined) return;
      const si = stopIdx.get(r[cols.stop]);
      if (si === undefined) return;
      const arr = fastTime(r[cols.arr]);
      const dep = fastTime(r[cols.dep]);
      const n = tTrip.n;
      tTrip.push(ti);
      tSeq.push(+r[cols.seq]);
      tStop.push(si);
      tArr.push(arr >= 0 ? arr : dep);
      tDep.push(dep >= 0 ? dep : arr);
      let f = 0;
      if (cols.pu >= 0 && r[cols.pu] === "1") f |= FLAG_NO_PICKUP;
      if (cols.dropOff >= 0 && r[cols.dropOff] === "1") f |= FLAG_NO_DROPOFF;
      tFlags.push(f);
      const plat = cols.plat >= 0 ? r[cols.plat] : "";
      const track = cols.track >= 0 ? r[cols.track] : "";
      if (plat || track) tPlat.set(n, track ? `${plat || "?"}/${track}` : plat);
    };
    const stream = new CsvStream(onRow);
    let foundStopTimes = false;
    const uz = new Unzip();
    uz.register(UnzipInflate);
    const dec = new TextDecoder("utf-8");
    uz.onfile = (file) => {
      if (base(file.name) !== "stop_times.txt") return;
      foundStopTimes = true;
      file.ondata = (err, data, final) => {
        if (err) throw err;
        // decode in slices: one huge chunk would exceed V8's max string length
        const SLICE = 8 << 20;
        for (let i = 0; i < data.length; i += SLICE) {
          const end = Math.min(i + SLICE, data.length);
          const last = final && end === data.length;
          stream.push(dec.decode(data.subarray(i, end), { stream: !last }), last);
        }
        if (final && data.length === 0) stream.push(dec.decode(), true);
      };
      file.start();
    };
    // feed the zip in pieces so inflated output arrives in manageable chunks
    const PIECE = 1 << 20;
    for (let i = 0; i < zip.length; i += PIECE) uz.push(zip.subarray(i, Math.min(i + PIECE, zip.length)), i + PIECE >= zip.length);
    if (!foundStopTimes) throw new Error(`${def.id}: missing stop_times.txt`);

    // counting sort by trip, then (usually no-op) insertion sort by seq within each trip
    const n = tTrip.n;
    const nTrips = this.tripCount - firstTrip;
    const counts = new Int32Array(nTrips + 1);
    for (let i = 0; i < n; i++) counts[tTrip.a[i] - firstTrip + 1]++;
    for (let i = 0; i < nTrips; i++) counts[i + 1] += counts[i];
    const order = new Int32Array(n);
    const fill = counts.slice();
    for (let i = 0; i < n; i++) order[fill[tTrip.a[i] - firstTrip]++] = i;
    for (let t = 0; t < nTrips; t++) {
      const a = counts[t];
      const b = counts[t + 1];
      for (let i = a + 1; i < b; i++) {
        const x = order[i];
        const sx = tSeq.a[x];
        let j = i - 1;
        while (j >= a && tSeq.a[order[j]] > sx) {
          order[j + 1] = order[j];
          j--;
        }
        order[j + 1] = x;
      }
    }
    let stopTimes = 0;
    for (let t = 0; t < nTrips; t++) {
      const a = counts[t];
      const b = counts[t + 1];
      if (b - a < 2) continue;
      const ti = firstTrip + t;
      const start = this.stStop.n;
      for (let k = a; k < b; k++) {
        const o = order[k];
        const g = this.stStop.n;
        this.stStop.push(tStop.a[o]);
        this.stArr.push(tArr.a[o]);
        this.stDep.push(tDep.a[o]);
        this.stSeq.push(tSeq.a[o]);
        this.stFlags.push(tFlags.a[o]);
        const p = tPlat.get(o);
        if (p) this.stPlatform.set(g, p);
      }
      this.interpolate(start, b - a);
      this.tripStart.a[ti] = start;
      this.tripLen.a[ti] = b - a;
      stopTimes += b - a;
    }

    // number index (train numbers, names; bus line numbers are not indexed)
    for (let t = firstTrip; t < this.tripCount; t++) {
      if (this.tripLen.a[t] === 0) continue;
      const route = this.routes[this.tripRoute.a[t]];
      if (route.mode !== MODE.rail) continue;
      const keys = new Set<string>();
      const num = this.tripNumber[t];
      if (num) for (const part of num.split(/[\/,\s]+/)) if (part) keys.add(part.toLowerCase());
      if (this.tripShort[t]) keys.add(this.tripShort[t].toLowerCase());
      if (this.tripName[t]) keys.add(normalize(this.tripName[t]));
      for (const k of keys) {
        let arr = this.numberIndex.get(k);
        if (!arr) this.numberIndex.set(k, (arr = []));
        arr.push(t);
      }
    }

    this.feeds.push({
      def,
      validFrom,
      validTo,
      agencies: [...new Set(agencies.values())],
      stats: { stops: this.stopCount - firstStop, trips: this.tripCount - firstTrip, stopTimes },
      loadedAt: Date.now(),
    });
  }

  private newStation(name: string, lat: number, lon: number, feed: number): number {
    const si = this.stations.length;
    this.stations.push({
      name,
      lat,
      lon,
      stops: [],
      feeds: new Set([feed]),
      modes: 0,
      tokens: tokens(name),
      norm: normalize(name),
      weight: 0,
    });
    return si;
  }

  private attachStop(gi: number, si: number) {
    this.stopStation[gi] = si;
    const s = this.stations[si];
    s.stops.push(gi);
    if (!Number.isFinite(s.lat) || s.lat === 0) {
      s.lat = this.lat.a[gi];
      s.lon = this.lon.a[gi];
    }
  }

  /** Fill stop_times without times by linear interpolation on index. */
  private interpolate(start: number, len: number) {
    const arr = this.stArr.a;
    const dep = this.stDep.a;
    let last = -1;
    for (let k = 0; k < len; k++) {
      const g = start + k;
      if (dep[g] >= 0) {
        if (last >= 0 && k - last > 1) {
          const t0 = dep[start + last];
          const t1 = arr[g] >= 0 ? arr[g] : dep[g];
          for (let m = last + 1; m < k; m++) {
            const v = Math.round(t0 + ((t1 - t0) * (m - last)) / (k - last));
            arr[start + m] = v;
            dep[start + m] = v;
          }
        }
        last = k;
      }
    }
  }

  // ---- finalize ------------------------------------------------------------

  finalize(): void {
    this.stopLat = this.lat.done();
    this.stopLon = this.lon.done();
    const tr = this.tripRoute.a;
    const ts = this.tripStart.a;
    const tl = this.tripLen.a;
    const stStop = this.stStop.a;
    // station modes & weights
    for (let t = 0; t < this.tripCount; t++) {
      const mode = this.routes[tr[t]].mode;
      for (let k = ts[t], e = ts[t] + tl[t]; k < e; k++) {
        const st = this.stations[this.stopStation[stStop[k]]];
        st.modes |= mode;
        st.weight++;
      }
    }
    for (const st of this.stations) {
      for (const s of st.stops) st.feeds.add(this.stopFeed[s]);
      // station centroid from stops when parent coordinates are missing
      if (!Number.isFinite(st.lat) || st.lat === 0) {
        const s0 = st.stops[0];
        st.lat = this.stopLat[s0];
        st.lon = this.stopLon[s0];
      }
    }
    this.buildFootpaths();
    this.finalized = true;
    log(
      "info",
      `network ready: ${this.feeds.length} feeds, ${this.stations.length} stations, ${this.stopCount} stops, ${this.tripCount} trips, ${this.stStop.n} stop times`,
    );
  }

  /**
   * Walking links: every pair of stops in the same station (duration 0 -> the
   * transfer buffer applies), plus stops within maxWalkMeters (walking time).
   */
  private buildFootpaths() {
    const n = this.stopCount;
    const grid = new GridIndex(0.005);
    for (let i = 0; i < n; i++) grid.add(i, this.stopLat[i], this.stopLon[i]);
    const maxM = config.maxWalkMeters;
    const lists: { to: number[]; dur: number[] }[] = new Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const to: number[] = [];
      const dur: number[] = [];
      const st = this.stations[this.stopStation[i]];
      const seen = new Set<number>();
      if (st.stops.length <= 60) {
        for (const j of st.stops)
          if (j !== i) {
            const d = distM(this.stopLat[i], this.stopLon[i], this.stopLat[j], this.stopLon[j]);
            to.push(j);
            dur.push(d > 150 ? walkSecs(d) : 0);
            seen.add(j);
          }
      }
      if (maxM > 0) {
        for (const j of grid.near(this.stopLat[i], this.stopLon[i], maxM)) {
          if (j === i || seen.has(j)) continue;
          const d = distM(this.stopLat[i], this.stopLon[i], this.stopLat[j], this.stopLon[j]);
          if (d <= maxM) {
            to.push(j);
            dur.push(walkSecs(d));
          }
        }
      }
      lists[i] = { to, dur };
      total += to.length;
    }
    this.fpStart = new Int32Array(n + 1);
    this.fpTo = new Int32Array(total);
    this.fpDur = new Int32Array(total);
    let p = 0;
    for (let i = 0; i < n; i++) {
      this.fpStart[i] = p;
      const l = lists[i];
      for (let k = 0; k < l.to.length; k++) {
        this.fpTo[p] = l.to[k];
        this.fpDur[p] = l.dur[k];
        p++;
      }
    }
    this.fpStart[n] = p;
  }

  // ---- accessors -------------------------------------------------------------

  tripRouteOf(t: number): Route {
    return this.routes[this.tripRoute.a[t]];
  }

  isActive(t: number, day: number): boolean {
    return this.serviceDays[this.tripService.a[t]].has(day);
  }

  /** Human label of a trip: "train IC 3510 SOLINA" / "bus 410" / "tram 16". */
  tripLabel(t: number): string {
    const r = this.tripRouteOf(t);
    const num = this.tripNumber[t];
    const name = this.tripName[t];
    if (r.mode === MODE.rail) {
      const parts = [r.shortName, num, name && name !== r.shortName ? name : ""].filter(Boolean);
      return `train ${parts.join(" ") || r.longName || ""}`.trim();
    }
    const kind = MODE_NAMES[r.mode] ?? "bus";
    const line = r.shortName || r.longName || this.tripShort[t];
    return line ? `${kind} ${line}` : kind;
  }

  /** Walking seconds between two stops (0 within one station when close). */
  walkTime(a: number, b: number): number {
    const d = distM(this.stopLat[a], this.stopLon[a], this.stopLat[b], this.stopLon[b]);
    if (this.stopStation[a] === this.stopStation[b] && d <= 150) return 0;
    return walkSecs(d);
  }

  stationOfStop(s: number): Station {
    return this.stations[this.stopStation[s]];
  }
}

/** "HH:MM:SS" -> seconds without allocations; -1 if empty. */
function fastTime(s: string | undefined): number {
  if (!s) return -1;
  let i = 0;
  const len = s.length;
  while (i < len && s.charCodeAt(i) === 32) i++;
  let h = 0, m = 0, sec = 0, part = 0, any = false;
  for (; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c === 58) {
      part++;
      continue;
    }
    if (c < 48 || c > 57) break;
    any = true;
    const d = c - 48;
    if (part === 0) h = h * 10 + d;
    else if (part === 1) m = m * 10 + d;
    else sec = sec * 10 + d;
  }
  if (!any || part < 1) return -1;
  return h * 3600 + m * 60 + sec;
}

function walkSecs(m: number): number {
  // 1.2 m/s with 1.3 detour factor, plus a minute to find the way
  return Math.round(60 + (m * 1.3) / 1.2);
}
