import { Network, FLAG_NO_PICKUP, FLAG_NO_DROPOFF } from "./network.js";

const DAY = 86400;
const INF = 0x3fffffff;
/** Keep scanning this long after the fastest arrival to find options with fewer changes. */
const PARETO_SLACK = 2 * 3600;
/** How far into the next day connections are kept (overnight trips). */
const NEXT_DAY_HOURS = 14;

/**
 * All connections (consecutive stop pairs of a trip run) for a query day,
 * sorted by departure. Times are seconds since the query day's midnight;
 * trips of the previous/next service day are shifted by -/+ 24h.
 */
export class DayConnections {
  dep!: Int32Array;
  arr!: Int32Array;
  from!: Int32Array;
  to!: Int32Array;
  /** trip instance index */
  inst!: Int32Array;
  /** stop_time index of the departure end */
  st!: Int32Array;
  flags!: Uint8Array;
  instTrip!: Int32Array;
  instOffset!: Int32Array;
  count = 0;

  constructor(public net: Network, public day: number, modeMask: number) {
    this.build(modeMask);
  }

  private build(modeMask: number) {
    const net = this.net;
    const tStart = net.tripStart.a;
    const tLen = net.tripLen.a;
    const sArr = net.stArr.a;
    const sDep = net.stDep.a;
    const sStop = net.stStop.a;
    const sFlags = net.stFlags.a;
    const instTrip: number[] = [];
    const instOffset: number[] = [];
    // Window: previous-day runs still going after midnight, the whole day,
    // and the next day until noon (overnight journeys).
    const lo = 0;
    const hi = DAY + NEXT_DAY_HOURS * 3600;
    let total = 0;
    for (let t = 0; t < net.tripCount; t++) {
      const len = tLen[t];
      if (len < 2) continue;
      if ((net.tripRouteOf(t).mode & modeMask) === 0) continue;
      const first = sDep[tStart[t]];
      const last = sArr[tStart[t] + len - 1];
      for (const off of [-1, 0, 1]) {
        const o = off * DAY;
        if (last + o < lo || first + o > hi) continue;
        if (!net.isActive(t, this.day + off)) continue;
        instTrip.push(t);
        instOffset.push(o);
        total += len - 1;
      }
    }
    // counting sort by departure second
    const span = hi - lo + 2 * DAY + 2;
    const shift = DAY; // departures can be as early as -DAY
    const counts = new Int32Array(span + 1);
    for (let i = 0; i < instTrip.length; i++) {
      const t = instTrip[i];
      const o = instOffset[i];
      for (let k = tStart[t], e = tStart[t] + tLen[t] - 1; k < e; k++) {
        const d = Math.min(Math.max(sDep[k] + o + shift, 0), span - 1);
        counts[d + 1]++;
      }
    }
    for (let i = 0; i < span; i++) counts[i + 1] += counts[i];
    const dep = new Int32Array(total);
    const arr = new Int32Array(total);
    const from = new Int32Array(total);
    const to = new Int32Array(total);
    const inst = new Int32Array(total);
    const st = new Int32Array(total);
    const flags = new Uint8Array(total);
    for (let i = 0; i < instTrip.length; i++) {
      const t = instTrip[i];
      const o = instOffset[i];
      for (let k = tStart[t], e = tStart[t] + tLen[t] - 1; k < e; k++) {
        const d = sDep[k] + o;
        const c = counts[Math.min(Math.max(d + shift, 0), span - 1)]++;
        dep[c] = d;
        arr[c] = Math.max(sArr[k + 1] + o, d);
        from[c] = sStop[k];
        to[c] = sStop[k + 1];
        inst[c] = i;
        st[c] = k;
        flags[c] = (sFlags[k] & FLAG_NO_PICKUP ? 1 : 0) | (sFlags[k + 1] & FLAG_NO_DROPOFF ? 2 : 0);
      }
    }
    this.dep = dep;
    this.arr = arr;
    this.from = from;
    this.to = to;
    this.inst = inst;
    this.st = st;
    this.flags = flags;
    this.instTrip = Int32Array.from(instTrip);
    this.instOffset = Int32Array.from(instOffset);
    this.count = total;
  }

  /** First connection index with dep >= t. */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.dep[m] < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
}

export interface Endpoint {
  /** stop index -> walking seconds from/to the place (0 for the stop itself) */
  stops: Map<number, number>;
  label: string;
}

export interface RideLeg {
  kind: "ride";
  inst: number;
  trip: number;
  /** stop_time index of boarding / alighting */
  boardSt: number;
  alightSt: number;
  dep: number;
  arr: number;
  offset: number;
}
export interface WalkLeg {
  kind: "walk";
  from: number;
  to: number;
  dep: number;
  arr: number;
  /** true when this is an in-station change (no real walk) */
  change: boolean;
}
export type Leg = RideLeg | WalkLeg;

export interface Journey {
  dep: number;
  arr: number;
  rides: number;
  legs: Leg[];
}

export interface RouteOptions {
  maxTransfers: number;
  minTransferSec: number;
  /** stop searching this many seconds after start */
  horizonSec: number;
}

/**
 * Multi-criteria (arrival time x number of rides) Connection Scan.
 * Reuses buffers between runs.
 */
export class Router {
  private K = 0;
  private R!: Int32Array; // ready-to-board time [k][stop]
  private S!: Int32Array; // arrival by ride [k][stop]
  private Rkind!: Uint8Array; // 1 origin, 2 change, 3 walk
  private Rfrom!: Int32Array; // stop we walked from / -1
  private Sboard!: Int32Array; // connection index of boarding
  private Sexit!: Int32Array; // connection index of alighting
  private Tk!: Uint8Array; // min rides with which trip instance is boarded (255 = no)
  private Tboard!: Int32Array;
  private nStops = 0;
  private nInst = 0;
  private destWalk: Int32Array | null = null;
  private destVia: Int32Array | null = null;

  constructor(private net: Network) {}

  private ensure(K: number, nInst: number) {
    const n = this.net.stopCount;
    if (this.K !== K || this.nStops !== n) {
      this.K = K;
      this.nStops = n;
      const size = (K + 1) * n;
      this.R = new Int32Array(size);
      this.S = new Int32Array(size);
      this.Rkind = new Uint8Array(size);
      this.Rfrom = new Int32Array(size);
      this.Sboard = new Int32Array(size);
      this.Sexit = new Int32Array(size);
    }
    if (this.nInst < nInst) {
      this.nInst = nInst;
      this.Tk = new Uint8Array(nInst);
      this.Tboard = new Int32Array(nInst);
    }
    this.R.fill(INF);
    this.S.fill(INF);
    this.Rkind.fill(0);
    this.Tk.fill(255, 0, nInst);
  }

  /**
   * Earliest arrival for each ride count 1..K. Returns Pareto-optimal journeys
   * (fewer rides first) departing not earlier than `start`.
   */
  search(dc: DayConnections, origin: Endpoint, dest: Endpoint, start: number, opt: RouteOptions): Journey[] {
    const K = Math.max(1, Math.min(8, opt.maxTransfers + 1));
    const n = this.net.stopCount;
    this.ensure(K, dc.instTrip.length);
    const { R, S, Rkind, Rfrom, Sboard, Sexit, Tk, Tboard } = this;
    const fpStart = this.net.fpStart;
    const fpTo = this.net.fpTo;
    const fpDur = this.net.fpDur;
    const change = opt.minTransferSec;

    // round 0: origin (+ walks to nearby stops)
    for (const [s, w] of origin.stops) {
      const t = start + w;
      if (t < R[s]) {
        R[s] = t;
        Rkind[s] = w === 0 ? 1 : 3;
        Rfrom[s] = -1;
      }
    }
    for (const [s, w] of origin.stops) {
      if (w !== 0) continue;
      for (let p = fpStart[s], pe = fpStart[s + 1]; p < pe; p++) {
        const v = fpTo[p];
        const t = start + fpDur[p];
        if (t < R[v]) {
          R[v] = t;
          Rkind[v] = 3;
          Rfrom[v] = s;
        }
      }
    }
    const destStops = [...dest.stops.entries()];
    // destWalk[v]: seconds from alighting at v to the destination (INF if not near)
    if (!this.destWalk || this.destWalk.length !== n) {
      this.destWalk = new Int32Array(n);
      this.destVia = new Int32Array(n);
    }
    const destWalk = this.destWalk.fill(INF);
    const destVia = this.destVia!.fill(-1);
    for (const [s, w] of destStops) {
      if (w < destWalk[s]) destWalk[s] = w;
    }
    for (const [s, w] of destStops) {
      // reverse footpaths: stops from which s is reachable on foot (footpaths are symmetric)
      for (let p = fpStart[s], pe = fpStart[s + 1]; p < pe; p++) {
        const u = fpTo[p];
        const t = fpDur[p] + w;
        if (t < destWalk[u] && !dest.stops.has(u)) {
          destWalk[u] = t;
          // find the footpath u -> s to report the walk
          let via = -1;
          for (let q = fpStart[u], qe = fpStart[u + 1]; q < qe; q++) if (fpTo[q] === s) via = q;
          destVia[u] = via;
        }
      }
    }
    const best = new Int32Array(K + 1).fill(INF); // best arrival at destination with <=k rides
    const bestStop = new Int32Array(K + 1).fill(-1);

    const end = start + opt.horizonSec;
    const { dep, arr, from, to, inst, flags } = dc;
    let target = INF;
    for (let c = dc.lowerBound(start); c < dc.count; c++) {
      const d = dep[c];
      if (d > end || d > target) break;
      const ti = inst[c];
      const u = from[c];
      // try boarding with the fewest rides possible
      if ((flags[c] & 1) === 0) {
        const cur = Tk[ti];
        for (let k = 1; k <= K && k < cur; k++) {
          if (R[(k - 1) * n + u] <= d) {
            Tk[ti] = k;
            Tboard[ti] = c;
            break;
          }
        }
      }
      const k = Tk[ti];
      if (k === 255) continue;
      if (flags[c] & 2) continue; // cannot alight here
      const v = to[c];
      const a = arr[c];
      const base = k * n;
      if (a >= S[base + v]) continue;
      // update S for k..K (at most k rides)
      for (let kk = k; kk <= K; kk++) {
        const idx = kk * n + v;
        if (a < S[idx]) {
          S[idx] = a;
          Sboard[idx] = Tboard[ti];
          Sexit[idx] = c;
        } else break;
      }
      // ready times after alighting: same stop (change) and footpaths
      for (let kk = k; kk <= K; kk++) {
        const ro = kk * n;
        let improved = false;
        const rv = a + change;
        if (rv < R[ro + v]) {
          R[ro + v] = rv;
          Rkind[ro + v] = 2;
          Rfrom[ro + v] = v;
          improved = true;
        }
        for (let p = fpStart[v], pe = fpStart[v + 1]; p < pe; p++) {
          const w = fpTo[p];
          const t = a + Math.max(change, fpDur[p]);
          if (t < R[ro + w]) {
            R[ro + w] = t;
            Rkind[ro + w] = 3;
            Rfrom[ro + w] = v;
            improved = true;
          }
        }
        if (!improved) break;
      }
      // destination check (direct or via a short walk; precomputed)
      const dw = destWalk[v];
      if (dw < INF) {
        const ta = a + dw;
        for (let kk = k; kk <= K; kk++) {
          if (ta < best[kk]) {
            best[kk] = ta;
            bestStop[kk] = destVia[v] >= 0 ? -2 - destVia[v] : v;
          }
        }
        target = Math.min(best[1], best[K] + PARETO_SLACK);
      }
    }
    void destStops;

    const out: Journey[] = [];
    let prevArr = INF;
    for (let k = 1; k <= K; k++) {
      if (best[k] >= prevArr || best[k] >= INF) continue;
      const j = this.reconstruct(dc, k, bestStop[k], best[k], dest);
      if (j) {
        out.push(j);
        prevArr = best[k];
      }
    }
    return out;
  }

  private reconstruct(dc: DayConnections, k: number, endCode: number, arrival: number, dest: Endpoint): Journey | null {
    const n = this.nStops;
    const legs: Leg[] = [];
    let stop: number;
    if (endCode <= -2) {
      const p = -2 - endCode;
      const w = this.net.fpTo[p];
      // find the stop v such that p belongs to v's footpath range
      let v = 0;
      let lo = 0,
        hi = n;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (this.net.fpStart[m + 1] <= p) lo = m + 1;
        else hi = m;
      }
      v = lo;
      const a = this.S[k * n + v];
      legs.push({ kind: "walk", from: v, to: w, dep: a, arr: a + this.net.fpDur[p], change: false });
      stop = v;
    } else stop = endCode;
    void dest;

    let guard = 0;
    while (k > 0 && guard++ < 50) {
      const idx = k * n + stop;
      const b = this.Sboard[idx];
      const e = this.Sexit[idx];
      if (this.S[idx] >= INF) return null;
      const ti = dc.inst[b];
      legs.push({
        kind: "ride",
        inst: ti,
        trip: dc.instTrip[ti],
        boardSt: dc.st[b],
        alightSt: dc.st[e] + 1,
        dep: dc.dep[b],
        arr: dc.arr[e],
        offset: dc.instOffset[ti],
      });
      const boardStop = dc.from[b];
      k--;
      // how did we become ready at boardStop with k rides?
      const ridx = k * n + boardStop;
      const kind = this.Rkind[ridx];
      if (k === 0) {
        const f = this.Rfrom[ridx];
        if (kind === 3 && f >= 0 && f !== boardStop) {
          const walk = this.net.walkTime(f, boardStop);
          const board = (legs[legs.length - 1] as RideLeg).dep;
          if (walk > 0) legs.push({ kind: "walk", from: f, to: boardStop, dep: board - walk, arr: board, change: false });
        }
        stop = boardStop;
        break;
      }
      if (kind === 2) {
        stop = boardStop;
        legs.push({ kind: "walk", from: boardStop, to: boardStop, dep: this.S[k * n + boardStop], arr: this.R[ridx], change: true });
      } else if (kind === 3) {
        const f = this.Rfrom[ridx];
        const a = this.S[k * n + f];
        legs.push({ kind: "walk", from: f, to: boardStop, dep: a, arr: this.R[ridx], change: f === boardStop || this.net.stopStation[f] === this.net.stopStation[boardStop] });
        stop = f;
      } else return null;
    }
    legs.reverse();
    const rides = legs.filter((l) => l.kind === "ride") as RideLeg[];
    if (rides.length === 0) return null;
    const dep = legs[0].kind === "walk" ? legs[0].dep : rides[0].dep;
    return { dep, arr: arrival, rides: rides.length, legs };
  }
}

export function journeyKey(j: Journey): string {
  return j.legs
    .filter((l): l is RideLeg => l.kind === "ride")
    .map((l) => `${l.trip}@${l.offset}:${l.boardSt}-${l.alightSt}`)
    .join("|");
}
