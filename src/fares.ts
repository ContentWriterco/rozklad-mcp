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

export interface FareQuote {
  category: string;
  class2: number;
  class1: number;
  basis: string;
  carrier: string;
  validFrom: string;
  source: string;
}

type PairIndex = Map<string, { via: string[]; class2: number; class1: number }[]>;

export class Fares {
  private tables: { t: FareTable; pairs: Map<string, PairIndex>; cities: string[] }[] = [];

  constructor(files?: string[]) {
    for (const f of files ?? defaultFareFiles()) {
      try {
        const t = JSON.parse(readFileSync(f, "utf8")) as FareTable;
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
    return this.tables.length > 0;
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
    const tb = this.tables.find((x) => x.t.agency_id === agencyId);
    if (!tb) return null;
    const cat = category.toUpperCase();
    const meta = { carrier: tb.t.carrier, validFrom: tb.t.valid_from, source: tb.t.source };
    if (tb.t.distance_bands.categories.includes(cat)) {
      if (km == null || !Number.isFinite(km) || km <= 0) return null;
      const k = Math.max(1, Math.round(km));
      const row = tb.t.distance_bands.rows.find(([from, to]) => k >= from && k <= to);
      if (!row) return null;
      return { category: cat, class2: row[2], class1: row[3], basis: `${k} km`, ...meta };
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

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function defaultFareFiles(): string[] {
  if (process.env.ROZKLAD_FARES === "0") return [];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, "..", "data", "fares"), join(here, "..", "..", "data", "fares")]) {
    const f = join(dir, "pkpic.json");
    if (existsSync(f)) return [f];
  }
  return [];
}
