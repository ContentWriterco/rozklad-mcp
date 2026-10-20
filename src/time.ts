/** Date/time helpers. All timetable times are local Europe/Warsaw. */

export const TZ = "Europe/Warsaw";
const DAY = 86400;

/** Days since 1970-01-01 for a calendar date (no timezone involved). */
export function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export function dayFromYmd(ymd: string): number {
  // Accepts YYYYMMDD or YYYY-MM-DD
  const s = ymd.replace(/-/g, "");
  return dayNumber(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
}

export function ymdFromDay(day: number, sep = "-"): string {
  const d = new Date(day * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${sep}${m}${sep}${dd}`;
}

const WEEKDAYS_PL = ["nd", "pn", "wt", "śr", "cz", "pt", "sb"];
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 0 = Sunday ... 6 = Saturday */
export function weekday(day: number): number {
  return new Date(day * 86400000).getUTCDay();
}

export function prettyDate(day: number): string {
  const d = new Date(day * 86400000);
  return `${WEEKDAYS_EN[d.getUTCDay()]} ${ymdFromDay(day)} (${WEEKDAYS_PL[d.getUTCDay()]})`;
}

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Local Warsaw wall-clock for an instant: {day, secs since local midnight}. */
export function localParts(date: Date): { day: number; secs: number } {
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  const day = dayNumber(+p.year, +p.month, +p.day);
  const secs = +p.hour * 3600 + +p.minute * 60 + +p.second;
  return { day, secs };
}

export function nowLocal(): { day: number; secs: number } {
  return localParts(new Date());
}

/** Parse "HH:MM[:SS]" (hours may exceed 24) to seconds. Returns -1 if empty/invalid. */
export function parseGtfsTime(s: string): number {
  if (!s) return -1;
  const a = s.trim().split(":");
  if (a.length < 2) return -1;
  const h = +a[0];
  const m = +a[1];
  const sec = a.length > 2 ? +a[2] : 0;
  if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(sec)) return -1;
  return h * 3600 + m * 60 + sec;
}

/** Seconds (relative to a reference midnight) -> "HH:MM", with "+1" day suffix if needed. */
export function hhmm(secs: number): string {
  let dayOff = Math.floor(secs / DAY);
  let s = secs - dayOff * DAY;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const base = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dayOff === 0) return base;
  return dayOff > 0 ? `${base}(+${dayOff})` : `${base}(${dayOff})`;
}

export function duration(secs: number): string {
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h${String(mm).padStart(2, "0")}` : `${h}h`;
}

/**
 * Resolve user date input: "today", "tomorrow", "jutro", "YYYY-MM-DD", "DD.MM.YYYY", weekday names.
 * Returns a day number or null.
 */
export function parseDateInput(input: string | undefined, today: number): number | null {
  if (!input) return today;
  const s = input.trim().toLowerCase();
  if (["today", "dzis", "dziś", "dzisiaj", "now", "teraz"].includes(s)) return today;
  if (["tomorrow", "jutro"].includes(s)) return today + 1;
  if (["pojutrze", "day after tomorrow"].includes(s)) return today + 2;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return dayNumber(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return dayNumber(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/);
  if (m) {
    let y = m[3] ? +m[3] : new Date(today * 86400000).getUTCFullYear();
    if (y < 100) y += 2000;
    let d = dayNumber(y, +m[2], +m[1]);
    if (!m[3] && d < today) d = dayNumber(y + 1, +m[2], +m[1]);
    return d;
  }
  const names: Record<string, number> = {
    sunday: 0, sun: 0, niedziela: 0, nd: 0,
    monday: 1, mon: 1, poniedzialek: 1, poniedziałek: 1, pn: 1,
    tuesday: 2, tue: 2, wtorek: 2, wt: 2,
    wednesday: 3, wed: 3, sroda: 3, środa: 3, sr: 3,
    thursday: 4, thu: 4, czwartek: 4, cz: 4,
    friday: 5, fri: 5, piatek: 5, piątek: 5, pt: 5,
    saturday: 6, sat: 6, sobota: 6, sb: 6,
  };
  if (s in names) {
    const target = names[s];
    const wd = weekday(today);
    return today + ((target - wd + 7) % 7);
  }
  return null;
}

/** "HH:MM" / "H" / "now" -> seconds since midnight, or null. */
export function parseTimeInput(input: string | undefined, nowSecs: number): number | null {
  if (!input) return nowSecs;
  const s = input.trim().toLowerCase();
  if (["now", "teraz"].includes(s)) return nowSecs;
  const m = s.match(/^(\d{1,2})(?:[:.h](\d{2}))?$/);
  if (!m) return null;
  const h = +m[1];
  const mm = m[2] ? +m[2] : 0;
  if (h > 47 || mm > 59) return null;
  return h * 3600 + mm * 60;
}
