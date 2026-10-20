# Changelog

## 0.1.0 – 2026-10-20

Pierwsza wersja.

- Narzędzia MCP: `plan_journey`, `departures`, `trip_details`, `find_stops`, `nearby_stops`, `data_sources` + prompt `plan_trip`.
- Wszystkie pociągi w Polsce (PKP PLK via mkuran.pl) + WKD, PKS Poznań, PKS Kalisz, przewoźnicy kaliscy, Sindbad, Kombus; opcjonalnie komunikacja miejska ~20 miast.
- Przesiadki pociąg ↔ autobus (grupowanie stacji + przejścia piesze), „przyjazd do”, współrzędne jako start/cel, opóźnienia i odwołania na żywo.
- stdio i Streamable HTTP, Docker, CLI.
