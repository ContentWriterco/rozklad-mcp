import { VERSION } from "./version.js";

const REPO = "https://github.com/ContentWriterco/rozklad-mcp";
const OG = "https://raw.githubusercontent.com/ContentWriterco/rozklad-mcp/main/docs/social-preview.png";
const DEMO = "https://raw.githubusercontent.com/ContentWriterco/rozklad-mcp/main/docs/demo-pl.svg";

/** Public landing page of an HTTP instance (shown at "/"). `base` = public origin, e.g. https://rozklad.compabase.com */
export function landingHtml(base: string, stats: boolean): string {
  const mcp = `${base}/mcp`;
  return `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>rozkład-mcp – rozkład jazdy PKP, PKS i komunikacji miejskiej dla AI (serwer MCP)</title>
<meta name="description" content="Darmowy serwer MCP z rozkładami wszystkich pociągów w Polsce, autobusów PKS, FlixBusa i komunikacji miejskiej 25 miast: wyszukiwarka połączeń z przesiadkami, odjazdy, opóźnienia na żywo i ceny biletów dla Claude, ChatGPT i Cursora.">
<link rel="canonical" href="${base}/">
<meta property="og:title" content="rozkład-mcp – rozkład jazdy PKP i PKS dla Twojego asystenta AI">
<meta property="og:description" content="Połączenia z przesiadkami, odjazdy, opóźnienia na żywo i ceny – w Claude, ChatGPT i każdym kliencie MCP. Bez klucza API.">
<meta property="og:image" content="${OG}"><meta property="og:url" content="${base}/"><meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "rozklad-mcp",
    applicationCategory: "TravelApplication",
    operatingSystem: "Any",
    softwareVersion: VERSION,
    description: "MCP server with Polish train, bus and city transit timetables: journey planning, departures, live delays and fares.",
    url: `${base}/`,
    codeRepository: REPO,
    license: "https://opensource.org/licenses/MIT",
    offers: { "@type": "Offer", price: "0", priceCurrency: "PLN" },
    publisher: { "@type": "Organization", name: "Compabase (Content Writer sp. z o.o.)", url: "https://compabase.com" },
  })}</script>
<style>
:root{--bg:#fff;--fg:#1f2328;--mut:#59636e;--card:#f6f8fa;--bd:#d1d9e0;--acc:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#9198a1;--card:#151b23;--bd:#3d444d;--acc:#4493f8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:900px;margin:0 auto;padding:48px 16px 64px}h1{font-size:40px;line-height:1.15;margin:0 0 12px}h1 span{color:var(--acc)}
h2{font-size:22px;margin:40px 0 12px}p.lead{font-size:19px;color:var(--mut);margin:0 0 24px}
.ep{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px 14px;font:15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ep code{flex:1;min-width:0;overflow-wrap:anywhere}button{font:600 14px inherit;font-family:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);cursor:pointer}
img.demo{width:100%;height:auto;margin:28px 0 8px}ul{padding-left:20px}li{margin:6px 0}
pre{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:12px;overflow:auto;font-size:14px}a{color:var(--acc)}
.small{color:var(--mut);font-size:14px}
</style></head><body><main>
<h1>rozkład<span>-mcp</span></h1>
<p class="lead">Rozkład jazdy PKP, PKS i komunikacji miejskiej dla Twojego asystenta AI. Wyszukiwarka połączeń z przesiadkami, odjazdy, opóźnienia na żywo i ceny biletów – w Claude, ChatGPT, Cursorze i każdym kliencie MCP. Za darmo, bez klucza API.</p>
<div class="ep"><code id="u">${mcp}</code><button onclick="navigator.clipboard.writeText(document.getElementById('u').textContent);this.textContent='Skopiowano'">Kopiuj adres MCP</button></div>
<img class="demo" src="${DEMO}" alt="Animacja: asystent AI planuje podróż ze Zbąszynia do Kórnika pociągiem IC i autobusem PKS przy pomocy rozklad-mcp" width="860" height="470">
<h2>Jak podłączyć</h2>
<ul>
<li><b>Claude</b> (web, desktop): Ustawienia → Connectors → <i>Add custom connector</i> → wklej adres powyżej.</li>
<li><b>ChatGPT</b>: Settings → Connectors (tryb deweloperski) → dodaj serwer MCP z tym adresem.</li>
<li><b>Claude Code</b>: <code>claude mcp add --transport http rozklad ${mcp}</code></li>
<li><b>Cursor / VS Code</b>: <code>{"mcpServers": {"rozklad": {"url": "${mcp}"}}}</code></li>
<li><b>Lokalnie</b> (stdio, z komunikacją miejską do wyboru): <code>npx -y rozklad-mcp</code></li>
</ul>
<h2>Co potrafi</h2>
<ul>
<li><b>plan_journey</b> – połączenia A → B z przesiadkami pociąg ↔ autobus ↔ tramwaj, „przyjazd do”, ceny z cenników PKP Intercity i przewoźników regionalnych oraz link do dokładnej ceny i biletu.</li>
<li><b>departures</b> – tablica odjazdów z peronami i opóźnieniami.</li>
<li><b>trip_details</b> – cały przebieg pociągu lub autobusu z opóźnieniem na każdym przystanku.</li>
<li><b>rail_disruptions</b> – utrudnienia i komunikacja zastępcza PKP PLK.</li>
<li><b>find_stops</b>, <b>nearby_stops</b>, <b>data_sources</b>.</li>
</ul>
<p>Dane: wszystkie pociągi w Polsce (PKP PLK), PKS-y publikujące otwarte dane, FlixBus oraz komunikacja miejska ~25 miast (Warszawa, Kraków, Łódź, Poznań, Trójmiasto, GZM, Szczecin…). Opóźnienia na żywo: pociągi oraz miasta publikujące GTFS-Realtime.</p>
<h2>Przykładowe pytania</h2>
<ul><li>„Jak dostanę się jutro na 9:00 z Wrocławia do Zakopanego?”</li><li>„Co odjeżdża teraz z przystanku Kraków Rondo Mogilskie?”</li><li>„Ile kosztuje IC z Poznania do Warszawy w piątek po 16:00?”</li></ul>
<p class="small">Projekt open source (MIT): <a href="${REPO}">GitHub</a> · <a href="https://www.npmjs.com/package/rozklad-mcp">npm</a> · oficjalny katalog MCP: <code>io.github.ContentWriterco/rozklad-mcp</code>${stats ? ` · <a href="/stats">statystyki użycia</a> (anonimowe, bez adresów IP)` : ""} · wersja ${VERSION}. Hostowane pro publico bono przez <a href="https://compabase.com">Compabase</a>. Projekt niezależny, niezwiązany z Grupą PKP ani przewoźnikami.</p>
<p class="small" lang="en"><b>English:</b> free MCP server with Polish train, bus and city transit timetables – journey planning with changes, departures, live delays and fares for Claude, ChatGPT and any MCP client. Endpoint: <code>${mcp}</code></p>
</main></body></html>`;
}
