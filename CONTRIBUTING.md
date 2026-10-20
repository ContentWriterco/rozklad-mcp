# Jak pomóc

Dzięki, że chcesz pomóc! Najbardziej przydają się **nowe źródła danych** (PKS-y, miasta, przewoźnicy prywatni).

## Dodanie przewoźnika / miasta

1. Znajdź plik GTFS (`.zip` z `stops.txt`, `stop_times.txt` itd.). Dobre miejsca:
   - strona przewoźnika („dla deweloperów”, „otwarte dane”, „GTFS”),
   - [Krajowy Punkt Dostępowy MMTIS na dane.gov.pl](https://dane.gov.pl/pl/dataset/1739,krajowy-punkt-dostepowy-kpd-multimodalne-usugi-informacji-o-podrozach) (tabela przewoźników z linkami),
   - [Mobility Database](https://mobilitydatabase.org/), [Transitland](https://www.transit.land/places/Poland).
2. Upewnij się, że dane można ponownie wykorzystywać (otwarte dane / informacja sektora publicznego / licencja CC). **Nie dodajemy danych ze scrapingu.**
3. Dopisz wpis do `feeds/feeds.json`:

```json
{
  "id": "pks-przyklad",
  "name": "PKS Przykład Sp. z o.o.",
  "group": "regional",
  "region": "mazowieckie",
  "url": "https://przyklad.pl/gtfs.zip",
  "homepage": "https://przyklad.pl/otwarte-dane",
  "license": "Public sector information (KPD MMTIS)",
  "attribution": "Dane: PKS Przykład Sp. z o.o."
}
```

   - `group`: `trains` (koleje), `regional` (PKS, busy, linie podmiejskie i dalekobieżne), `city` (komunikacja miejska; dodaj też `"city": "Nazwa"`).
   - Gdy link zmienia się z każdą wersją rozkładu, zamiast `url` użyj `discover`:
     `{"page": "https://strona-z-linkiem", "pattern": "regex-do-linku-zip", "pick": "first" | "last" | "covering"}`
     (`covering` wybiera plik, którego nazwa zawiera zakres dat obejmujący dziś – grupy nazwane `from`/`to` w regexie).
   - `fallbackUrls`: zapasowe adresy (np. IP), gdy domena bywa niedostępna.
4. Sprawdź:

```bash
npm run build
npm run check-feeds -- pks-przyklad
ROZKLAD_FEEDS=pks-przyklad,trains node dist/index.js departures "Jakaś Miejscowość"
```

5. Otwórz Pull Request. W opisie podaj, skąd jest link i jaka jest licencja.

## Kod

- TypeScript, Node ≥ 20, bez natywnych zależności. `npm test` musi przechodzić (testy działają offline).
- Nowe zachowanie = nowy test w `test/` (syntetyczna sieć w `test/fixture.mjs`).
- Odpowiedzi narzędzi są pisane dla modeli językowych: krótko, jednoznacznie, z `ref`-ami do dalszych pytań. Nie zwiększaj ich rozmiaru bez potrzeby.
- Logi tylko na stderr (stdout to protokół MCP).

## Zgłaszanie błędów w danych

Błędy w samym rozkładzie najczęściej pochodzą od źródła (przewoźnik, PKP PLK, konwerter GTFS). Zgłoś je u nas z przykładem (`trip_details` + `ref`) – pomożemy przekazać dalej.
