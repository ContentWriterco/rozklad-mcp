/**
 * Minimal GTFS-Realtime (protobuf) decoder for TripUpdates - no dependencies.
 * Spec: https://gtfs.org/realtime/reference/
 */

export interface RtStopUpdate {
  seq?: number;
  stopId?: string;
  arrDelay?: number;
  arrTime?: number;
  depDelay?: number;
  depTime?: number;
  /** 0 scheduled, 1 skipped, 2 no data */
  rel: number;
}
export interface RtTripUpdate {
  tripId: string;
  routeId?: string;
  startDate?: string;
  startTime?: string;
  /** 0 scheduled, 1 added, 2 unscheduled, 3 canceled, 5 replacement, 6 duplicated, 7 deleted */
  rel: number;
  delay?: number;
  stops: RtStopUpdate[];
}
export interface RtFeed {
  timestamp?: number;
  trips: RtTripUpdate[];
}

class Reader {
  pos = 0;
  constructor(
    public buf: Uint8Array,
    public end = buf.length,
  ) {}
  varint(): number {
    // values used here fit in 53 bits (timestamps), decode as float arithmetic
    let result = 0;
    let mul = 1;
    for (;;) {
      if (this.pos >= this.end) throw new Error("truncated varint");
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
      if (mul > 2 ** 70) throw new Error("varint too long");
    }
  }
  /** int32/int64 encoded as plain varint (negative = 10-byte two's complement). */
  int(): number {
    // negative int32/int64 are 10-byte varints; doubles lose the low bits, so decode those via BigInt
    const start = this.pos;
    let n = 0;
    while (n < 10 && this.buf[start + n] >= 0x80) n++;
    if (n < 8) return this.varint();
    let v = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.buf[this.pos++];
      v |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) break;
      shift += 7n;
    }
    return Number(BigInt.asIntN(64, v));
  }
  bytes(): Uint8Array {
    const len = this.varint();
    const s = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error("truncated field");
    return this.buf.subarray(s, s + len);
  }
  sub(): Reader {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos + len);
    r.pos = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error("truncated message");
    return r;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const n = this.varint(); // read first: `this.pos += this.varint()` would use the stale pos
      this.pos += n;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  /** Iterate fields: callback(field, wire). Callback must consume or return false to skip. */
  each(fn: (field: number, wire: number) => boolean) {
    while (this.pos < this.end) {
      const tag = this.varint();
      const field = Math.floor(tag / 8);
      const wire = tag & 7;
      if (!fn(field, wire)) this.skip(wire);
    }
  }
}

const utf8 = new TextDecoder();

function stopTimeEvent(r: Reader): { delay?: number; time?: number } {
  const ev: { delay?: number; time?: number } = {};
  r.each((f, w) => {
    if (f === 1 && w === 0) ev.delay = r.int();
    else if (f === 2 && w === 0) ev.time = r.int();
    else return false;
    return true;
  });
  return ev;
}

function stopTimeUpdate(r: Reader): RtStopUpdate {
  const u: RtStopUpdate = { rel: 0 };
  r.each((f, w) => {
    if (f === 1 && w === 0) u.seq = r.varint();
    else if ((f === 2 || f === 3) && w === 2) {
      const ev = stopTimeEvent(r.sub());
      if (f === 2) {
        u.arrDelay = ev.delay;
        u.arrTime = ev.time;
      } else {
        u.depDelay = ev.delay;
        u.depTime = ev.time;
      }
    } else if (f === 4 && w === 2) u.stopId = utf8.decode(r.bytes());
    else if (f === 5 && w === 0) u.rel = r.varint();
    else return false;
    return true;
  });
  return u;
}

function tripUpdate(r: Reader): RtTripUpdate {
  const t: RtTripUpdate = { tripId: "", rel: 0, stops: [] };
  r.each((f, w) => {
    if (f === 1 && w === 2) {
      const d = r.sub();
      d.each((g, x) => {
        if (g === 1 && x === 2) t.tripId = utf8.decode(d.bytes());
        else if (g === 2 && x === 2) t.startTime = utf8.decode(d.bytes());
        else if (g === 3 && x === 2) t.startDate = utf8.decode(d.bytes());
        else if (g === 4 && x === 0) t.rel = d.varint();
        else if (g === 5 && x === 2) t.routeId = utf8.decode(d.bytes());
        else return false;
        return true;
      });
    } else if (f === 2 && w === 2) t.stops.push(stopTimeUpdate(r.sub()));
    else if (f === 5 && w === 0) t.delay = r.int();
    else return false;
    return true;
  });
  return t;
}

export function decodeTripUpdates(buf: Uint8Array): RtFeed {
  const feed: RtFeed = { trips: [] };
  const r = new Reader(buf);
  r.each((f, w) => {
    if (f === 1 && w === 2) {
      const h = r.sub();
      h.each((g, x) => {
        if (g === 3 && x === 0) feed.timestamp = h.varint();
        else return false;
        return true;
      });
    } else if (f === 2 && w === 2) {
      const e = r.sub();
      let deleted = false;
      let tu: RtTripUpdate | null = null;
      e.each((g, x) => {
        if (g === 2 && x === 0) deleted = e.varint() === 1;
        else if (g === 3 && x === 2) tu = tripUpdate(e.sub());
        else return false;
        return true;
      });
      if (tu && !deleted && (tu as RtTripUpdate).tripId) feed.trips.push(tu);
    } else return false;
    return true;
  });
  return feed;
}
