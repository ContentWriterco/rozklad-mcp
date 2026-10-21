# Changelog

## 0.3.3 – 2026-10-21

- `/.well-known/security.txt` z adresem operatora (`ROZKLAD_CONTACT`), m.in. do weryfikacji w katalogach MCP.

## 0.3.2 – 2026-10-21

- Strona główna serwera HTTP (`/` w przeglądarce): opis, adres MCP do skopiowania, instrukcje podłączenia, demo, dane strukturalne i podgląd linku (Open Graph). `ROZKLAD_PUBLIC_URL` ustawia adres publiczny.

## 0.3.1 – 2026-10-21

- `plan_journey`: link „exact price & tickets” do Koleo dla części kolejowej każdego połączenia (aktualna cena z promocjami, zakup biletu). Bez pobierania cen ze sklepów.
- README: animowane demo (PL/EN), przykładowe pytania, odznaki.

## 0.3.0 – 2026-10-21

- **Komunikacja miejska na publicznym serwerze**: mniejsze zużycie pamięci (bufory bez zapasu, współdzielone napisy, budżet pamięci na tablice dni, krótsze okno nocne dla autobusów/tramwajów) – wszystkie feedy mieszczą się w ~1,2 GB. Przystanki miejskie z nazwą miasta („Kraków Rondo Mogilskie”); równie dobre trafienia w różnych miastach („Politechnika”) są zgłaszane jako niejednoznaczne.
- **Opóźnienia na żywo dla miast** (GTFS-Realtime): Kraków (autobusy, tramwaje), Poznań, Gdańsk, Szczecin. Własny dekoder protobuf, propagacja opóźnienia na kolejne przystanki.
- **Nowe dane**: FlixBus/FlixTrain (kursy z/do Polski, ODbL), Łódź, Legnica, Włocławek.
- **Ceny przewoźników regionalnych** z cenników (bilet normalny, 2. klasa, wg km): Polregio (REGIO / interREGIO), Koleje Mazowieckie, Śląskie, Dolnośląskie, Małopolskie, ŁKA (w tym Sprinter), Arriva. Generator `scripts/build-regional-fares.py`. Brak ceny dla odcinków zagranicznych.
- **Utrudnienia PKP PLK** (`rail_disruptions`, ostrzeżenia w `plan_journey`/`departures`/`trip_details`) – po ustawieniu `ROZKLAD_PLK_API_KEY`.
- **Anonimowe statystyki** publicznego serwera (`ROZKLAD_STATS=1`, `/stats`): liczniki narzędzi i wyników, klienci MCP, unikalni użytkownicy przez dzienną sól w pamięci; bez IP, współrzędnych i tras.
- „Kalisz” nie miesza się już z „Kaliszem Pomorskim” (dokładna nazwa wyznacza miasto).

## 0.2.0 – 2026-10-21

- Ceny z cennika PKP Intercity w `plan_journey`: TLK/IC według odległości po torze (z kształtu trasy GTFS; przy granicy przedziału ±4 km – widełki cen), EIC/EIP według par stacji (z uwzględnieniem „przez”). To cena maksymalna (bazowa) biletu normalnego; w sprzedaży bywa niższa.
- Zweryfikowane na sprzedaży PKP IC: m.in. IC 8322 Poznań Gł. – Konin = dokładnie 33,00 / 43,00 zł, EIC 8100 Poznań – Warszawa 1. kl. = 214,00 zł.
- Dane: `data/fares/pkpic.json`, generator `scripts/build-pkpic-fares.py` (z PDF cennika).

## 0.1.0 – 2026-10-20

Pierwsza wersja.

- Narzędzia MCP: `plan_journey`, `departures`, `trip_details`, `find_stops`, `nearby_stops`, `data_sources` + prompt `plan_trip`.
- Wszystkie pociągi w Polsce (PKP PLK via mkuran.pl) + WKD, PKS Poznań, PKS Kalisz, przewoźnicy kaliscy, Sindbad, Kombus; opcjonalnie komunikacja miejska ~20 miast.
- Przesiadki pociąg ↔ autobus (grupowanie stacji + przejścia piesze), „przyjazd do”, współrzędne jako start/cel, opóźnienia i odwołania na żywo.
- stdio i Streamable HTTP, Docker, CLI.
