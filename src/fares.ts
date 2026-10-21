import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "./text.js";
import { log } from "./config.js";

/**
 * Published price lists (maximum "base" prices before discounts/promotions).
 * Currently: PKP Intercity "Cennik usług przewozowych" (TLK/IC by tariff km, EIC/EIP by station pair).
 * Source data: data/fares/*.json, built by scripts/build-pkpic-fares.py from the carrier's PDF.
 */
export interface FareTable {
  carrier: string;
  agency_id: string;
  source: string;
  valid_from: string;
  multi_station_cities: string[];
  distance_bands: { categories: string[]; rows: [number, number, number, number][] };
  pairs: Record<string, { rows: [string, string, string[], number, number][] }>;
}

/** data/fares/regional.json: km tables of regional carriers (2nd class only). */
export interface RegionalFares {
  carriers: {
    agency_id: string;
    carrier: string;
    valid_from: string;
    source: string;
    document?: string;
    /** first table whose categories match (or "*") applies */
    tables: { name: string; categories: string[]; rows: [number, number, number][] }[];
    exclude_stations?: string[];
  }[];
}

export interface FareQuote {
  category: string;
  class2: number;
  /** undefined when the carrier has no 1st class */
  class1?: number;
  /** Set when the distance is close to a band boundary (track geometry differs by a few km between trains). */
  class2Max?: number;
  class1Max?: number;
  basis: string;
  carrier: string;
  validFrom: string;
  source: string;
}

type PairIndex = Map<string, { via: string[]; class2: number; class1: number }[]>;

export class Fares {
  private tables: { t: FareTable; pairs: Map<string, PairIndex>; cities: string[] }[] = [];
  private regional = new Map<string, RegionalFares["carriers"][number]>();

  constructor(files?: string[]) {
    for (const f of files ?? defaultFareFiles()) {
      try {
        const raw = JSON.parse(readFileSync(f, "utf8"));
        if (Array.isArray(raw.carriers)) {
          for (const c of (raw as RegionalFares).carriers) this.regional.set(c.agency_id, c);
          continue;
        }
        const t = raw as FareTable;
        const pairs = new Map<string, PairIndex>();
        for (const [cat, tbl] of Object.entries(t.pairs)) {
          const idx: PairIndex = new Map();
          for (const [a, b, via, c2, c1] of tbl.rows) {
            const k = pairKey(normalize(a), normalize(b));
            let arr = idx.get(k);
            if (!arr) idx.set(k, (arr = []));
            arr.push({ via: via.map(normalize), class2: c2, class1: c1 });
          }
          pairs.set(cat.toUpperCase(), idx);
        }
        // longest city names first so "Gdańsk" does not shadow e.g. "Gdańsk Główny"-style keys
        const cities = [...t.multi_station_cities].sort((a, b) => b.length - a.length);
        this.tables.push({ t, pairs, cities });
      } catch (e) {
        log("warn", `fares: cannot load ${f}: ${(e as Error).message}`);
      }
    }
  }

  get loaded(): boolean {
    return this.tables.length > 0 || this.regional.size > 0;
  }

  /** Station name -> key used in the price list (city for multi-station cities). */
  static stationKey(name: string, cities: string[]): string {
    for (const c of cities) if (name === c || name.startsWith(c + " ")) return normalize(c);
    return normalize(name);
  }

  /**
   * Quote for one ride. `km` = distance along the track (for km tables);
   * `stationNames` = all stops of the ride from boarding to alighting (for EIC/EIP "via").
   */
  quote(agencyId: string, category: string, km: number | null, stationNames: string[]): FareQuote | null {
    // replacement buses (ZKA) are priced like the train they replace
    const cat = category.toUpperCase().replace(/^ZKA\s+/, "");
    const reg = this.regional.get(agencyId);
    if (reg) {
      if (km == null || !Number.isFinite(km) || km <= 0) return null;
      if (reg.exclude_stations?.some((x) => stationNames[0]?.startsWith(x) || stationNames[stationNames.length - 1]?.startsWith(x))) return null;
      const table = reg.tables.find((t) => t.categories.includes(cat)) ?? reg.tables.find((t) => t.categories.includes("*"));
      if (!table) return null;
      const k = Math.max(1, Math.round(km));
      const band = (x: number) => table.rows.find(([from, to]) => x >= from && x <= to);
      const row = band(k);
      if (!row) return null;
      const tol = kmTolerance(k);
      const lo = band(Math.max(1, k - tol)) ?? row;
      const hi = band(k + tol) ?? row;
      const q: FareQuote = { category: cat, class2: lo[2], basis: `~${k} km`, carrier: reg.carrier, validFrom: reg.valid_from, source: reg.source };
      if (hi[2] !== lo[2]) q.class2Max = hi[2];
      return q;
    }
    const tb = this.tables.find((x) => x.t.agency_id === agencyId);
    if (!tb) return null;
    const meta = { carrier: tb.t.carrier, validFrom: tb.t.valid_from, source: tb.t.source };
    if (tb.t.distance_bands.categories.includes(cat)) {
      if (km == null || !Number.isFinite(km) || km <= 0) return null;
      const k = Math.max(1, Math.round(km));
      const band = (x: number) => tb.t.distance_bands.rows.find(([from, to]) => x >= from && x <= to);
      const row = band(k);
      if (!row) return null;
      // distance along mapped track deviates from the tariff distance by up to a few km
      const tol = kmTolerance(k);
      const lo = band(Math.max(1, k - tol)) ?? row;
      const hi = band(k + tol) ?? row;
      const q: FareQuote = { category: cat, class2: lo[2], class1: lo[3], basis: `~${k} km`, ...meta };
      if (hi[2] !== lo[2] || hi[3] !== lo[3]) {
        q.class2Max = hi[2];
        q.class1Max = hi[3];
      }
      return q;
    }
    const idx = tb.pairs.get(cat);
    if (!idx || stationNames.length < 2) return null;
    const keys = stationNames.map((n) => Fares.stationKey(n, tb.cities));
    const a = keys[0];
    const b = keys[keys.length - 1];
    if (a === b) return null;
    const cands = idx.get(pairKey(a, b));
    if (!cands?.length) return null;
    const passed = new Set(keys.slice(1, -1));
    // most specific "via" row whose via-cities the train actually passes; else the plain row
    const fitting = cands
      .filter((c) => c.via.every((v) => passed.has(v)))
      .sort((x, y) => y.via.length - x.via.length);
    const pick = fitting[0];
    if (!pick) return null;
    return { category: cat, class2: pick.class2, class1: pick.class1, basis: "station pair", ...meta };
  }
}

/** Tolerance (km) between distance along the mapped track and the official tariff distance. */
export const KM_TOLERANCE = 4;

/** Absolute deviation grows with distance: ~4% of the ride, at least 1 km, at most KM_TOLERANCE. */
function kmTolerance(km: number): number {
  return Math.min(KM_TOLERANCE, Math.max(1, Math.round(km * 0.04)));
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function defaultFareFiles(): string[] {
  if (process.env.ROZKLAD_FARES === "0") return [];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, "..", "data", "fares"), join(here, "..", "..", "data", "fares")]) {
    const files = ["pkpic.json", "regional.json"].map((n) => join(dir, n)).filter((f) => existsSync(f));
    if (files.length) return files;
  }
  return [];
}
