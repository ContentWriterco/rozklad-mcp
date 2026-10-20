/** Distance in metres between two WGS84 points (equirectangular approximation, fine below ~50 km). */
export function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.sqrt(x * x + y * y) * 6371000;
}

/** Simple uniform grid spatial index over points. */
export class GridIndex {
  private cells = new Map<string, number[]>();
  constructor(private cellDeg = 0.01) {}
  private key(lat: number, lon: number) {
    return `${Math.floor(lat / this.cellDeg)}:${Math.floor(lon / this.cellDeg)}`;
  }
  add(id: number, lat: number, lon: number) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return;
    const k = this.key(lat, lon);
    let c = this.cells.get(k);
    if (!c) this.cells.set(k, (c = []));
    c.push(id);
  }
  /** Candidate ids within roughly `radiusM` (caller must filter by exact distance). */
  near(lat: number, lon: number, radiusM: number): number[] {
    const dLat = radiusM / 111000;
    const r = Math.ceil(dLat / this.cellDeg) + 1;
    const cy = Math.floor(lat / this.cellDeg);
    const cx = Math.floor(lon / this.cellDeg);
    const out: number[] = [];
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r * 2; x <= cx + r * 2; x++) {
        const c = this.cells.get(`${y}:${x}`);
        if (c) for (const id of c) out.push(id);
      }
    return out;
  }
}
