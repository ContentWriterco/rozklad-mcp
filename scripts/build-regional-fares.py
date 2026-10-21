#!/usr/bin/env python3
"""
Builds data/fares/regional.json: km-based price lists (normal single ticket, 2nd class) of regional rail carriers.

Usage: python3 scripts/build-regional-fares.py [--cache DIR]
Requires `pdftotext` (poppler-utils). Downloads each carrier's published tariff PDF (see CARRIERS),
extracts the distance table(s) and writes one JSON with the source URL and validity date of each table.

Prices are the published list price (maximum): regional tariffs (e.g. Taryfa Pomorska, Małopolska,
Kujawsko-Pomorska), offers and promotions are often cheaper, so the server shows them as "price list (max)".
Re-use: public sector information published by the carriers (art. 5 of the Polish open data act, 2021).
"""
import json, os, re, subprocess, sys, urllib.request

UA = "rozklad-mcp (+https://github.com/ContentWriterco/rozklad-mcp)"

# page = 1-based PDF page with the table; col = which "band price" pair on each line (0 = first column)
POLREGIO = "https://polregio.pl/media/25853/tabele-op%C5%82at-dzia%C5%82-iii-taryfy-przewozowej-od-15122024-r-ca%C5%82o%C5%9B%C4%87.pdf"
CARRIERS = [
    {
        "agency_id": "PR", "carrier": "Polregio", "valid_from": "2024-12-15", "url": POLREGIO,
        "document": "Taryfa przewozowa Polregio (TPR), Dział III - Tabele opłat (tabela 1 REGIO, tabela 2 interREGIO)",
        "tables": [
            {"page": 3, "col": 1, "categories": ["IR"], "name": "interREGIO / superREGIO"},
            {"page": 3, "col": 0, "categories": ["*"], "name": "REGIO"},
        ],
    },
    {
        "agency_id": "AR", "carrier": "Arriva RP", "valid_from": "2025-01-01", "url": POLREGIO,
        "document": "Arriva RP Taryfa REGIO (stawki jak Polregio REGIO) - https://arriva.pl/1049/taryfa-regio",
        "tables": [{"page": 3, "col": 0, "categories": ["*"], "name": "Taryfa REGIO"}],
    },
    {
        "agency_id": "KD", "carrier": "Koleje Dolnośląskie", "valid_from": "2026-09-01",
        "url": "https://kolejedolnoslaskie.pl/wp-content/uploads/2026/08/Cennik-KD_2026-09-01_tekst-jednolity.pdf",
        "document": "Cennik KD (tekst jednolity od 1.09.2026), tabela 1",
        "tables": [{"page": 19, "col": 0, "categories": ["*"], "name": "Taryfa Podstawowa"}],
    },
    {
        "agency_id": "KS", "carrier": "Koleje Śląskie", "valid_from": "2025-12-14",
        "url": "https://www.kolejeslaskie.pl/app/uploads/2025/12/dzial-iv.-cennik-uslug-przewozowych-c-ks.pdf",
        "document": "Cennik usług przewozowych C-KŚ, Dział IV, tabela 1",
        "tables": [{"page": 5, "col": 0, "categories": ["*"], "name": "taryfa normalna"}],
    },
    {
        "agency_id": "KM", "carrier": "Koleje Mazowieckie", "valid_from": "2022-07-01",
        "url": "https://www.mazowieckie.com.pl/sites/default/files/Za%C5%82%C4%85cznik%20do%20Taryfy%20przewozowej%20Kolei%20Mazowieckich-KM%20(TP-KM)%20z%20uwzgl.%20Zmian%20nr%201-6_0.pdf",
        "document": "Załącznik do TP-KM (zm. 1-6), tabela 1 (obowiązuje od 1.07.2022)",
        "tables": [{"page": 13, "col": 0, "categories": ["*"], "name": "taryfa normalna"}],
    },
    {
        "agency_id": "KML", "carrier": "Koleje Małopolskie", "valid_from": "2026-04-01",
        "url": "https://kolejemalopolskie.com.pl/brepo/panel_repo/2026/03/19/cpt2dx/taryfa-przewozowa-kml-zm8-ost.pdf",
        "document": "Taryfa przewozowa KMŁ (tekst jednolity od 1.04.2026), cennik tabela 1",
        "tables": [{"page": 66, "col": None, "categories": ["*"], "name": "taryfa normalna"}],
        "exclude_stations": ["Kraków Lotnisko"],
    },
    {
        "agency_id": "LKA", "carrier": "Łódzka Kolej Aglomeracyjna", "valid_from": "2025-01-01",
        "url": "https://lka.lodzkie.pl/_data/Dokumenty/Taryfa/2024/TARYFA%20(%C5%81KA%20-%20TP)%20%20ze%20zmianami%20nr%201-31.pdf",
        "document": "Taryfa przewozowa ŁKA-TP (tekst ujednolicony od 1.01.2025), tabele 1-2",
        "tables": [
            {"page": 28, "col": 0, "categories": ["ŁS"], "name": "ŁKA Sprinter"},
            {"page": 27, "col": 0, "categories": ["*"], "name": "ŁKA"},
        ],
    },
]

ROW = re.compile(r"(do\s+\d+|\d+\s*[-–]\s*\d+)\s+(\d+,\d\d)")


def download(url, cache):
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, re.sub(r"[^A-Za-z0-9._-]", "_", url.split("/")[-1])[-80:])
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, "wb") as f:
            f.write(r.read())
    return path


def page_text(pdf, page):
    return subprocess.run(["pdftotext", "-layout", "-f", str(page), "-l", str(page), pdf, "-"],
                          capture_output=True, text=True, check=True).stdout


def parse_band(s):
    s = s.replace("–", "-").replace(" ", "")
    if s.startswith("do"):
        return 1, int(s[2:])
    a, b = s.split("-")
    return int(a), int(b)


def extract(pdf, page, col):
    rows = []
    for line in page_text(pdf, page).split("\n"):
        pairs = ROW.findall(line)
        if not pairs:
            continue
        chosen = pairs if col is None else ([pairs[col]] if len(pairs) > col else [])
        for band, price in chosen:
            lo, hi = parse_band(band)
            rows.append([lo, hi, round(float(price.replace(",", ".")), 2)])
    rows.sort()
    # sanity: contiguous bands, increasing prices
    for a, b in zip(rows, rows[1:]):
        assert b[0] == a[1] + 1, f"gap/overlap {a} {b} in {pdf} p{page}"
        assert b[2] >= a[2], f"price not increasing {a} {b} in {pdf} p{page}"
    assert rows and rows[0][0] == 1, f"no table on {pdf} p{page}"
    return rows


def main():
    cache = sys.argv[sys.argv.index("--cache") + 1] if "--cache" in sys.argv else ".fares-cache"
    out = {
        "definition": "cena biletu jednorazowego normalnego, klasa 2, wg odległości (cennik przewoźnika) - cena maksymalna; taryfy wojewódzkie, oferty i promocje bywają tańsze",
        "currency": "PLN",
        "carriers": [],
    }
    for c in CARRIERS:
        pdf = download(c["url"], cache)
        tables = []
        for t in c["tables"]:
            rows = extract(pdf, t["page"], t["col"])
            tables.append({"name": t["name"], "categories": t["categories"], "rows": rows})
            print(f'{c["agency_id"]:4} {t["name"]:28} {len(rows):3} bands, {rows[0]} ... {rows[-1]}', file=sys.stderr)
        out["carriers"].append({k: c[k] for k in ("agency_id", "carrier", "valid_from", "document")} |
                               {"source": c["url"] if c["agency_id"] != "AR" else "https://arriva.pl/1049/taryfa-regio",
                                "tables": tables, "exclude_stations": c.get("exclude_stations", [])})
    path = os.path.join(os.path.dirname(__file__), "..", "data", "fares", "regional.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print("wrote", os.path.normpath(path), file=sys.stderr)


if __name__ == "__main__":
    main()
