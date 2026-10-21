#!/usr/bin/env python3
"""
Builds data/fares/pkpic.json from PKP Intercity's published price list (Cennik usług przewozowych, PDF).

Usage: python3 scripts/build-pkpic-fares.py <cennik.pdf> <source-url> <valid-from YYYY-MM-DD>
Requires `pdftotext` (poppler-utils).

The price list gives "cena bazowa" = the MAXIMUM single-ticket price (before discounts, offers, promotions):
  - TLK and IC: by tariff distance (km bands)
  - EIC and EIP: per station/city pair (optionally "via" cities)
Re-use: public sector information published by PKP Intercity (art. 5 of the Polish open data act, 2021).
"""
import json, re, subprocess, sys

pdf, url, valid_from = sys.argv[1], sys.argv[2], sys.argv[3]
text = subprocess.run(["pdftotext", "-layout", pdf, "-"], capture_output=True, text=True, check=True).stdout
lines = text.split("\n")

def price(s): return round(float(s.replace(",", ".")), 2)

# ---- TLK/IC distance bands -------------------------------------------------
bands = []
for l in lines:
    m = re.match(r"^\s*(do 40|\d{4})(?:[–-]\d+)?\s+(\d+,\d\d)\s+(\d+,\d\d)\s*$", l)
    if m:
        frm = 1 if m.group(1) == "do 40" else int(m.group(1))
        bands.append([frm, price(m.group(2)), price(m.group(3))])
# keep the first monotonic run (the TLK/IC table)
out_bands = []
for b in bands:
    if out_bands and b[0] <= out_bands[-1][0]:
        break
    out_bands.append(b)
for i, b in enumerate(out_bands):
    b.insert(1, out_bands[i + 1][0] - 1 if i + 1 < len(out_bands) else 99999)
assert out_bands[0][:2] == [1, 40], out_bands[:2]

# ---- EIC / EIP station pairs -----------------------------------------------
pairs = {"EIC": [], "EIP": []}
sec = None
od = None
row_re = re.compile(r"^(.*?)(\d+,\d\d)\s+(\d+,\d\d)\s*$")
for l in lines:
    if "Ceny bazowe biletów jednorazowych w pociągach Express InterCity Premium" in l:
        sec = "EIP"; continue
    if "Ceny bazowe biletów jednorazowych w pociągach Express InterCity" in l:
        sec = "EIC"; continue
    if sec is None:
        continue
    m = row_re.match(l)
    if not m:
        continue
    left = m.group(1).rstrip()
    if not left.strip() or "odległość" in left:
        continue
    if not left.startswith(" "):
        parts = re.split(r"\s{3,}", left.strip())
        od = parts[0]
        rest = parts[1:]
    else:
        rest = re.split(r"\s{3,}", left.strip())
    if od is None or not rest:
        continue
    do = rest[0]
    via = [v.strip() for v in rest[1].split(",")] if len(rest) > 1 else []
    pairs[sec].append([od, do, via, price(m.group(2)), price(m.group(3))])

multi_station_cities = ["Częstochowa", "Gdańsk", "Kraków", "Poznań", "Przemyśl", "Sosnowiec", "Szczecin", "Warszawa"]
data = {
    "carrier": "PKP Intercity",
    "agency_id": "IC",
    "source": url,
    "valid_from": valid_from,
    "definition": "cena bazowa = maksymalna cena biletu jednorazowego (normalnego) przed ulgami, ofertami i promocjami",
    "currency": "PLN",
    "multi_station_cities": multi_station_cities,
    "distance_bands": {"categories": ["TLK", "IC"], "rows": out_bands, "columns": ["km_from", "km_to", "class2", "class1"]},
    "pairs": {k: {"columns": ["from", "to", "via", "class2", "class1"], "rows": v} for k, v in pairs.items()},
}
json.dump(data, open("data/fares/pkpic.json", "w"), ensure_ascii=False, separators=(",", ":"))
print(f"bands={len(out_bands)} EIC={len(pairs['EIC'])} EIP={len(pairs['EIP'])}")
print("first/last band", out_bands[0], out_bands[-1])
for sec in ("EIC", "EIP"):
    print(sec, [r for r in pairs[sec] if r[0] == "Poznań" and r[1] == "Warszawa"])
