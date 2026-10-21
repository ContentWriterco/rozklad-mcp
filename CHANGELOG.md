# Changelog

## 0.2.0 – 2026-10-21

- Ceny z cennika PKP Intercity w `plan_journey`: TLK/IC według odległości po torze (z kształtu trasy GTFS), EIC/EIP według par stacji (z uwzględnieniem „przez”). To cena maksymalna (bazowa) biletu normalnego; w sprzedaży bywa niższa.
- Zweryfikowane na sprzedaży PKP IC: m.in. IC 8322 Poznań Gł. – Konin = dokładnie 33,00 / 43,00 zł, EIC 8100 Poznań – Warszawa 1. kl. = 214,00 zł.
- Dane: `data/fares/pkpic.json`, generator `scripts/build-pkpic-fares.py` (z PDF cennika).

## 0.1.0 – 2026-10-20

Pierwsza wersja.

- Narzędzia MCP: `plan_journey`, `departures`, `trip_details`, `find_stops`, `nearby_stops`, `data_sources` + prompt `plan_trip`.
- Wszystkie pociągi w Polsce (PKP PLK via mkuran.pl) + WKD, PKS Poznań, PKS Kalisz, przewoźnicy kaliscy, Sindbad, Kombus; opcjonalnie komunikacja miejska ~20 miast.
- Przesiadki pociąg ↔ autobus (grupowanie stacji + przejścia piesze), „przyjazd do”, współrzędne jako start/cel, opóźnienia i odwołania na żywo.
- stdio i Streamable HTTP, Docker, CLI.
