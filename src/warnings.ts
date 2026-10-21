import { config, log } from "./config.js";

/**
 * Weather and flood warnings from IMGW-PIB (public data API, no key):
 * https://danepubliczne.imgw.pl/api/data/warningsmeteo (by county TERYT) and .../warningshydro (by area).
 * County of a point comes from GUGiK ULDK (GetCountyByXY).
 * Required attribution: "Źródłem pochodzenia danych jest Instytut Meteorologii i Gospodarki Wodnej – Państwowy Instytut Badawczy".
 */
export const IMGW_ATTRIBUTION = "Źródłem pochodzenia danych jest Instytut Meteorologii i Gospodarki Wodnej – Państwowy Instytut Badawczy (dane przetworzone)";

export interface MeteoWarning {
  event: string;
  level: number;
  probability?: number;
  from?: string;
  to?: string;
  text?: string;
  counties: Set<string>;
}
export interface HydroWarning {
  event: string;
  level: number;
  from?: string;
  to?: string;
  text?: string;
  areas: { voivodeship: string; desc: string }[];
}
export interface County {
  teryt: string;
  name: string;
  voivodeship: string;
}

const IMGW = process.env.ROZKLAD_IMGW_URL ?? "https://danepubliczne.imgw.pl/api/data";
const ULDK = process.env.ROZKLAD_ULDK_URL ?? "https://uldk.gugik.gov.pl/";
const TTL_SEC = 10 * 60;

type Raw = Record<string, unknown>;
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v).trim() || undefined);
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const pick = (r: Raw, ...keys: string[]) => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k];
  return undefined;
};

export class ImgwWarnings {
  meteo: MeteoWarning[] = [];
  hydro: HydroWarning[] = [];
  fetchedAt = 0;
  lastError = "";
  private inflight: Promise<void> | null = null;
  private counties = new Map<string, Promise<County | null>>();

  get enabled(): boolean {
    return !config.offline && process.env.ROZKLAD_WARNINGS !== "0";
  }

  async refresh(): Promise<void> {
    if (!this.enabled) return;
    if (this.fetchedAt && (Date.now() - this.fetchedAt) / 1000 < TTL_SEC) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const [m, h] = await Promise.all([getJson(`${IMGW}/warningsmeteo`), getJson(`${IMGW}/warningshydro`)]);
        this.load(m, h);
        this.lastError = "";
      } catch (e) {
        this.lastError = (e as Error).message;
        log("warn", `IMGW warnings unavailable: ${this.lastError}`);
      } finally {
        this.fetchedAt = Date.now();
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Parse API responses (public for tests). "No warnings" comes as {"message": ...}. */
  load(meteoRaw: unknown, hydroRaw: unknown) {
    const now = Date.now();
    const active = (to?: string) => !to || to.startsWith("9999") || Date.parse(to.replace(" ", "T") + "+02:00") > now - 3600_000;
    this.meteo = (Array.isArray(meteoRaw) ? (meteoRaw as Raw[]) : [])
      .map((r) => ({
        event: str(pick(r, "nazwa_zdarzenia", "zdarzenie")) ?? "ostrzeżenie",
        level: num(pick(r, "stopien", "stopień")),
        probability: num(pick(r, "prawdopodobienstwo")) || undefined,
        from: str(pick(r, "obowiazuje_od", "data_od")),
        to: str(pick(r, "obowiazuje_do", "data_do")),
        text: str(pick(r, "tresc", "przebieg")),
        counties: new Set(((pick(r, "teryt") as unknown[]) ?? []).map((t) => String(t).padStart(4, "0"))),
      }))
      .filter((w) => active(w.to));
    this.hydro = (Array.isArray(hydroRaw) ? (hydroRaw as Raw[]) : [])
      .map((r) => ({
        event: str(pick(r, "zdarzenie")) ?? "ostrzeżenie hydrologiczne",
        level: num(pick(r, "stopień", "stopien")),
        from: str(pick(r, "data_od")),
        to: str(pick(r, "data_do")),
        text: str(pick(r, "przebieg")),
        areas: ((pick(r, "obszary") as Raw[]) ?? []).map((a) => ({ voivodeship: str(a.wojewodztwo) ?? "", desc: str(a.opis) ?? "" })),
      }))
      // level -1 = drought: irrelevant for travel
      .filter((w) => w.level >= 1 && active(w.to));
  }

  /** County (powiat) at a point, via GUGiK ULDK; cached on a ~1 km grid. */
  countyAt(lat: number, lon: number): Promise<County | null> {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    let p = this.counties.get(key);
    if (!p) {
      p = (async () => {
        try {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 8000);
          const res = await fetch(`${ULDK}?request=GetCountyByXY&xy=${lon},${lat},4326&result=teryt,county,voivodeship`, {
            signal: ac.signal,
            headers: { "user-agent": config.userAgent },
          });
          clearTimeout(t);
          const txt = (await res.text()).trim().split("\n");
          if (txt[0] !== "0" || !txt[1]) return null;
          const [teryt, name, voivodeship] = txt[1].split("|");
          return { teryt, name: name.replace(/^powiat\s+/i, ""), voivodeship };
        } catch {
          this.counties.delete(key);
          return null;
        }
      })();
      this.counties.set(key, p);
      if (this.counties.size > 5000) this.counties.delete(this.counties.keys().next().value!);
    }
    return p;
  }

  meteoFor(county: County): MeteoWarning[] {
    return this.meteo.filter((w) => w.counties.has(county.teryt)).sort((a, b) => b.level - a.level);
  }

  hydroFor(county: County): HydroWarning[] {
    return this.hydro.filter((w) => w.areas.some((a) => a.voivodeship.toLowerCase() === county.voivodeship.toLowerCase()));
  }
}

async function getJson(url: string): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { "user-agent": config.userAgent, accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export function fmtMeteo(w: MeteoWarning): string {
  const until = !w.to ? "" : w.to.startsWith("9999") ? " do odwołania" : ` do ${w.to.slice(0, 16)}`;
  return `${w.event} – ${w.level}. stopień${w.probability ? ` (${w.probability}%)` : ""}${until}`;
}
