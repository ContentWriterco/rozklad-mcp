/** Growable typed arrays used while ingesting large GTFS files. */
export class GrowI32 {
  a: Int32Array;
  n = 0;
  constructor(cap = 1024) {
    this.a = new Int32Array(cap);
  }
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done(): Int32Array {
    return this.a.slice(0, this.n);
  }
}

export class GrowF64 {
  a: Float64Array;
  n = 0;
  constructor(cap = 1024) {
    this.a = new Float64Array(cap);
  }
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done(): Float64Array {
    return this.a.slice(0, this.n);
  }
}

export class GrowU8 {
  a: Uint8Array;
  n = 0;
  constructor(cap = 1024) {
    this.a = new Uint8Array(cap);
  }
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Uint8Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done(): Uint8Array {
    return this.a.slice(0, this.n);
  }
}

export function concatI32(a: Int32Array, b: Int32Array): Int32Array {
  const r = new Int32Array(a.length + b.length);
  r.set(a);
  r.set(b, a.length);
  return r;
}
