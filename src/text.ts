/** Text helpers: Polish-aware normalisation and fuzzy matching of stop names. */

const PL_MAP: Record<string, string> = { ł: "l", Ł: "l" };

/** Lowercase, strip diacritics (incl. ł), collapse punctuation to single spaces. */
export function normalize(s: string): string {
  return s
    .replace(/[łŁ]/g, (c) => PL_MAP[c] ?? c)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Common abbreviations in Polish stop names, expanded for matching. */
const ABBREV: Record<string, string> = {
  gl: "glowny",
  glow: "glowny",
  dw: "dworzec",
  dworzec: "dworzec",
  pks: "pks",
  centr: "centralna",
  wsch: "wschodnia",
  zach: "zachodnia",
  pd: "poludnie",
  pn: "polnoc",
  os: "osiedle",
  ul: "ulica",
  al: "aleja",
  pl: "plac",
  wlkp: "wielkopolski",
  maz: "mazowiecki",
};

export function tokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter(Boolean)
    .map((t) => ABBREV[t] ?? t);
}

/** Levenshtein distance with an early exit once `max` is exceeded. */
export function levenshtein(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = i;
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

/**
 * Score how well `query` matches a stop name (both already tokenised).
 * 0 = no match, 100 = exact.
 */
export function matchScore(q: string[], name: string[]): number {
  if (q.length === 0) return 0;
  const qs = q.join(" ");
  const ns = name.join(" ");
  if (qs === ns) return 100;
  if (ns.startsWith(qs + " ")) return 85;
  // Every query token is a prefix of some name token, in order.
  let ni = 0;
  let ordered = true;
  for (const t of q) {
    while (ni < name.length && !name[ni].startsWith(t)) ni++;
    if (ni >= name.length) {
      ordered = false;
      break;
    }
    ni++;
  }
  if (ordered) return 70 - Math.min(20, name.length - q.length);
  const all = q.every((t) => name.some((n) => n.startsWith(t)));
  if (all) return 55;
  if (ns.includes(qs)) return 45;
  // Typo tolerance on whole tokens.
  let fuzzyOk = 0;
  for (const t of q) {
    if (t.length < 4) {
      if (name.some((n) => n.startsWith(t))) fuzzyOk++;
      continue;
    }
    const lim = t.length >= 8 ? 2 : 1;
    if (name.some((n) => levenshtein(t, n.slice(0, t.length + 1), lim) <= lim || levenshtein(t, n, lim) <= lim)) fuzzyOk++;
  }
  if (fuzzyOk === q.length) return 35;
  return 0;
}

/** Strip trailing stop-post numbers ("Kalisz, Dworzec 01" -> "Kalisz, Dworzec") used to group bus posts. */
export function stationGroupName(name: string): string {
  return name
    .replace(/\s*[\(\[]?(st\.?|stan\.?|stanowisko|peron|sł\.?|nr)?\s*\d{1,3}[a-z]?[\)\]]?\s*$/i, "")
    .trim();
}
