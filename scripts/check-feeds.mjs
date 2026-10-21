// Checks that every feed in feeds/feeds.json can be downloaded and looks like GTFS.
// Usage: node scripts/check-feeds.mjs [feed-id ...]
import { readFileSync, appendFileSync } from "node:fs";
import { unzipSync } from "fflate";

const reg = JSON.parse(readFileSync(new URL("../feeds/feeds.json", import.meta.url), "utf8"));
const only = new Set(process.argv.slice(2));
const UA = "rozklad-mcp feed-check (+https://github.com/ContentWriterco/rozklad-mcp)";

async function get(url, ms = 120000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": UA } });
  } finally {
    clearTimeout(t);
  }
}

async function resolveUrls(f) {
  const urls = [];
  if (f.discover) {
    try {
      const html = (await (await get(f.discover.page, 60000)).text()).replace(/&amp;/g, "&");
      const m = [...html.matchAll(new RegExp(f.discover.pattern, "g"))];
      if (m.length) urls.push(f.discover.pick === "last" ? m[m.length - 1][0] : m[0][0]);
    } catch {}
  }
  if (f.url) urls.push(f.url);
  urls.push(...(f.fallbackUrls ?? []));
  return urls;
}

const rows = [];
let failed = 0;
for (const f of reg.feeds) {
  if (only.size && !only.has(f.id)) continue;
  let status = "FAIL";
  let info = "";
  for (const url of await resolveUrls(f)) {
    try {
      const res = await get(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const files = Object.keys(unzipSync(buf, { filter: (x) => !x.name.endsWith("shapes.txt") && !x.name.endsWith("stop_times.txt") }));
      const need = ["stops.txt", "routes.txt", "trips.txt"];
      const missing = need.filter((n) => !files.some((x) => x.endsWith(n)));
      if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
      status = "OK";
      info = `${(buf.length / 1e6).toFixed(1)} MB`;
      break;
    } catch (e) {
      info = `${url}: ${e.message}`;
    }
  }
  if (status !== "OK") failed++;
  rows.push(`| ${f.id} | ${f.group} | ${status} | ${info} |`);
  console.log(`${status.padEnd(4)} ${f.id.padEnd(18)} ${info}`);
}
// price lists referenced by data/fares/*.json: fail only when the document is gone (404/410);
// carriers' sites may block automated requests, which we report but do not try to get around.
try {
  const fares = JSON.parse(readFileSync(new URL("../data/fares/pkpic.json", import.meta.url), "utf8"));
  let status = "error";
  try {
    status = String((await get(fares.source, 60000)).status);
  } catch (e) {
    status = e.cause?.code || e.message;
  }
  const gone = status === "404" || status === "410";
  const ok = status === "200";
  if (gone) failed++;
  const label = ok ? "OK" : gone ? "FAIL" : "SKIP";
  const info = ok ? "price list reachable" : gone ? "price list removed - new version? rebuild data/fares/pkpic.json" : `not checked (${status})`;
  rows.push(`| fares:pkpic | fares | ${label} | ${info} |`);
  console.log(`${label.padEnd(4)} fares:pkpic        ${info}`);
} catch (e) {
  console.log(`SKIP fares:pkpic        ${e.message}`);
}
const md = ["| feed | group | status | info |", "|---|---|---|---|", ...rows].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Feed check\n\n${md}\n`);
console.log(`\n${rows.length - failed}/${rows.length} feeds OK`);
process.exit(failed ? 1 : 0);
