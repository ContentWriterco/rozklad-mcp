# rozkład-mcp 🚆🚌

**Polskie rozkłady jazdy dla Twojego agenta AI.** Serwer [MCP](https://modelcontextprotocol.io) z rozkładami wszystkich pociągów w Polsce, autobusów PKS i (opcjonalnie) komunikacji miejskiej – z wyszukiwaniem połączeń z przesiadkami, tablicą odjazdów i opóźnieniami na żywo.

Działa z Claude, ChatGPT, Cursorem, VS Code, Codexem i każdym klientem MCP. **Bez klucza API, bez rejestracji, za darmo** – tylko otwarte dane.

```
Ty:     Jak dostanę się jutro rano ze Zbąszynia do Kórnika?
Agent:  Najszybciej: 8:22 IC „Zielonogórzanin” do Poznania Gł. (peron 3),
        4 min pieszo na dworzec autobusowy, 9:15 PKS Poznań linia 212 → Kórnik 9:46.
        Alternatywa bez autobusu: 7:30 KW → Zbąszynek → EIC → Poznań → PKM4, Kórnik 9:09.
```

## Co potrafi

| Narzędzie | Do czego |
|---|---|
| `plan_journey` | Połączenia A → B z przesiadkami **pociąg ↔ autobus**, „wyjazd po” albo „przyjazd do”, limit przesiadek, wybór środków transportu. Miejsce = stacja, całe miasto („Kraków”) albo współrzędne. |
| `departures` | Tablica odjazdów/przyjazdów z peronami i opóźnieniami; filtr „tylko w kierunku Poznania”. |
| `trip_details` | Cały przebieg pociągu (po numerze: `3510`, `IC 3510`, nazwie: `Podhalanin` albo `ref`) z opóźnieniem na każdej stacji, odwołaniami i objazdami. |
| `find_stops` / `nearby_stops` | Wyszukiwanie stacji (literówki i brak polskich znaków OK) oraz przystanków w pobliżu punktu. |
| `data_sources` | Jakie dane są załadowane, do kiedy ważne, licencje i wymagane atrybucje. |

**Pokrycie (domyślnie):** wszyscy przewoźnicy kolejowi koordynowani przez PKP PLK – PKP Intercity, Polregio, Koleje Mazowieckie, SKM Trójmiasto, SKM Warszawa, Koleje Śląskie, Dolnośląskie, Wielkopolskie, Małopolskie, ŁKA, Arriva, RegioJet, Leo Express – plus WKD, **PKS Poznań, PKS Kalisz i przewoźnicy kaliscy, Sindbad, Kombus**. Opcjonalnie komunikacja miejska ~20 miast (Warszawa, Kraków, Poznań, Trójmiasto, GZM, Szczecin, Lublin, Białystok…). Pełna lista: [`feeds/feeds.json`](feeds/feeds.json).

Opóźnienia na żywo: pociągi (dane PKP PLK). Ceny biletów: niedostępne.

## Instalacja

Potrzebujesz Node.js ≥ 20. Zanim paczka trafi na npm, zamiast `rozklad-mcp` w poleceniach poniżej użyj `github:ContentWriterco/rozklad-mcp` (np. `npx -y github:ContentWriterco/rozklad-mcp`). Pierwsze uruchomienie pobiera ~40 MB rozkładów (potem cache i automatyczne odświeżanie co 12 h).

### Claude Desktop

`Settings → Developer → Edit Config` i dopisz:

```json
{
  "mcpServers": {
    "rozklad": {
      "command": "npx",
      "args": ["-y", "rozklad-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add rozklad --scope user -- npx -y rozklad-mcp
```

### Cursor / Windsurf

`~/.cursor/mcp.json` (Windsurf: `~/.codeium/windsurf/mcp_config.json`) – ten sam JSON co dla Claude Desktop.

### VS Code (Copilot)

`.vscode/mcp.json`:

```json
{ "servers": { "rozklad": { "type": "stdio", "command": "npx", "args": ["-y", "rozklad-mcp"] } } }
```

### OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.rozklad]
command = "npx"
args = ["-y", "rozklad-mcp"]
tool_timeout_sec = 120
```

### Zdalnie (HTTP) – ChatGPT, agenci w chmurze, n8n

```bash
npx -y rozklad-mcp --http --port 3000 --host 0.0.0.0
# endpoint: http://twoj-serwer:3000/mcp   (Streamable HTTP, bezstanowy)   health: /health
```

albo Docker:

```bash
docker build -t rozklad-mcp .
docker run -p 3000:3000 -v rozklad-cache:/data rozklad-mcp
```

### Z kodu źródłowego

```bash
git clone https://github.com/ContentWriterco/rozklad-mcp && cd rozklad-mcp
npm install && npm run build
node dist/index.js plan "Zbąszyń" "Kraków" --date jutro --time 7:00
```

## Konfiguracja

Zmienne środowiskowe (w JSON-ie klienta: `"env": { "ROZKLAD_FEEDS": "trains,regional,city:Poznań" }`):

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `ROZKLAD_FEEDS` | `trains,regional` | Grupy (`trains`, `regional`/`pks`, `city`), pojedyncze feedy (`warszawa`), miasta (`city:Kraków`), regiony (`region:wielkopolskie`), `all`, wykluczenia (`-sindbad`). |
| `ROZKLAD_EXTRA_FEEDS` | – | Własne pliki GTFS: `moj-pks=https://…/gtfs.zip;inny=https://…` |
| `ROZKLAD_FEEDS_FILE` | – | Własny rejestr feedów (np. w forku dla jednego regionu). |
| `ROZKLAD_MIN_TRANSFER` | `4` | Minimalny czas przesiadki (min). |
| `ROZKLAD_MAX_WALK_M` | `500` | Maks. dojście pieszo między przystankami przy przesiadce. |
| `ROZKLAD_REFRESH_HOURS` | `12` | Jak często sprawdzać nowe rozkłady. |
| `ROZKLAD_LIVE` | `1` | `0` wyłącza opóźnienia na żywo. |
| `ROZKLAD_CACHE_DIR` | cache systemu | Gdzie trzymać pobrane rozkłady. |

**Pamięć:** domyślny zestaw (pociągi + PKS) ≈ 400–600 MB RAM i ~3 s startu. Komunikacja miejska dużych miast jest cięższa (Warszawa sama ≈ +600 MB), dlatego włączasz ją świadomie, np. `trains,regional,city:Warszawa`.

## CLI (bez agenta)

```bash
rozklad-mcp plan "Warszawa" "Gdańsk" --date piątek --time 16:00
rozklad-mcp plan "Zbąszyń" "Gdańsk Główny" --time 9:00 --arrive-by
rozklad-mcp departures "Poznań Główny" --direction Wrocław --duration 180
rozklad-mcp trip "IC 3510" --date jutro
rozklad-mcp stops "szklarska"
rozklad-mcp sources
```

## Skąd dane? (i dlaczego bez klucza)

Wszystko pochodzi z **otwartych danych publikowanych przez przewoźników i zarządców** (ponowne wykorzystywanie informacji sektora publicznego, [Krajowy Punkt Dostępowy MMTIS](https://dane.gov.pl/pl/dataset/1739,krajowy-punkt-dostepowy-kpd-multimodalne-usugi-informacji-o-podrozach)):

- Pociągi: [Otwarte Dane Kolejowe PKP PLK](https://pdp-api.plk-sa.pl/) w formacie GTFS przygotowywanym przez [Mikołaja Kuranowskiego](https://mkuran.pl/gtfs/) ([PolishTrainsGTFS](https://github.com/MKuranowski/PolishTrainsGTFS)) – dzięki temu nie potrzebujesz własnego klucza API.
- Autobusy i miasta: pliki GTFS przewoźników i zarządów transportu (linki i licencje w [`feeds/feeds.json`](feeds/feeds.json)).

Serwer **nie scrapuje** stron przewoźników. Odpowiedzi zawierają wymagane atrybucje źródeł. Dane bywają niekompletne (np. zmiany w ostatniej chwili, autobusowa komunikacja zastępcza) – przed ważną podróżą sprawdź u przewoźnika.

## Brakuje Twojego PKS-u albo miasta? 🙋

To najprostszy i najcenniejszy sposób, żeby pomóc. Większość PKS-ów nie publikuje jeszcze danych – ale coraz więcej musi (rozporządzenie UE 2017/1926). Jeśli znasz link do pliku GTFS:

1. dopisz wpis do [`feeds/feeds.json`](feeds/feeds.json) (szablon w [CONTRIBUTING.md](CONTRIBUTING.md)),
2. `npm run check-feeds` – sprawdzi, czy link działa,
3. otwórz Pull Request.

Nie programujesz? Otwórz [zgłoszenie „Dodaj przewoźnika”](../../issues/new?template=nowy-przewoznik.yml) z linkiem albo nazwą firmy – albo napisz do przewoźnika, żeby opublikował GTFS w KPD.

**Szukamy pomocy:** Wrocław (blokuje pobieranie automatyczne), Łódź (brak stałego linku), PKS-y w całej Polsce, opóźnienia na żywo dla autobusów (GTFS-Realtime).

## Jak to działa

- GTFS (pociągi + autobusy + miasta) łączony w jedną sieć w pamięci; przystanki tej samej stacji grupowane, przystanki w promieniu 500 m łączone przejściem pieszym – stąd przesiadki pociąg ↔ PKS na dworcach.
- Wyszukiwanie: [Connection Scan Algorithm](https://arxiv.org/abs/1703.05997) w wariancie wielokryterialnym (czas przyjazdu × liczba przesiadek) – kilkadziesiąt ms na zapytanie dla całej Polski.
- Opóźnienia: GTFS-RT/JSON z danymi PKP PLK, cache 90 s.
- Zero natywnych zależności (działa na macOS/Windows/Linux/ARM), ~3 tys. linii TypeScriptu – łatwo zrozumieć i rozbudować.

## Rozwój

```bash
npm install
npm test            # build + testy (bez internetu, na syntetycznej sieci)
npm run check-feeds # czy wszystkie linki w rejestrze działają
ROZKLAD_LOG=debug node dist/index.js plan "A" "B"
```

Pomysły na rozwój: ceny biletów, GTFS-Realtime dla miast (Poznań, Gdańsk, Szczecin publikują), komunikacja zastępcza z komunikatów PLK, mapy tras (shapes), utrwalony indeks dla szybszego startu.

## Licencja

Kod: [MIT](LICENSE). Dane: na licencjach źródeł – patrz `data_sources` i [`feeds/feeds.json`](feeds/feeds.json). Projekt niezależny, niezwiązany z Grupą PKP ani przewoźnikami.

---

## English

**rozklad-mcp** is an MCP server that gives AI agents Polish public transport timetables: every train in Poland (all carriers dispatched by PKP PLK), PKS/regional buses that publish open data, and optionally urban transit in ~20 cities. Tools: `plan_journey` (multi-criteria connection scan with train↔bus transfers, depart-after / arrive-by, coordinates as endpoints), `departures`, `trip_details` (live delays & cancellations), `find_stops`, `nearby_stops`, `data_sources`. No API key: it uses open GTFS data (PKP PLK via mkuran.pl, carriers' own feeds). Install with `npx -y rozklad-mcp` in any MCP client, or run `--http` for a remote Streamable HTTP endpoint. Station names work with or without Polish diacritics; a bare town name means all of its stops. Contributions of new feeds are very welcome – see [CONTRIBUTING.md](CONTRIBUTING.md).
