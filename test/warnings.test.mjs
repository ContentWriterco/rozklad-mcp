import { test } from "node:test";
import assert from "node:assert/strict";
import { ImgwWarnings, fmtMeteo } from "../dist/warnings.js";

test("imgw: meteo warnings by county, floods by voivodeship, drought and 'no warnings' ignored", () => {
  const w = new ImgwWarnings();
  w.load(
    [
      { nazwa_zdarzenia: "Silny wiatr", stopien: "2", prawdopodobienstwo: "80", obowiazuje_od: "2026-10-21 12:00:00", obowiazuje_do: "9999-12-31 23:59:59", tresc: "Porywy do 90 km/h.", teryt: ["3064", "1261"] },
      { nazwa_zdarzenia: "Burze", stopien: "1", obowiazuje_do: "2000-01-01 00:00:00", teryt: ["3064"] },
    ],
    [
      { zdarzenie: "Susza hydrologiczna", "stopień": "-1", data_do: "9999-12-31 23:59:59", obszary: [{ wojewodztwo: "wielkopolskie", opis: "x" }] },
      { zdarzenie: "Wzrost stanów wody", "stopień": "1", data_do: "9999-12-31 23:59:59", obszary: [{ wojewodztwo: "Małopolskie", opis: "Wisła" }] },
    ],
  );
  const poz = { teryt: "3064", name: "Poznań", voivodeship: "wielkopolskie" };
  const krk = { teryt: "1261", name: "Kraków", voivodeship: "małopolskie" };
  assert.equal(w.meteoFor(poz).length, 1); // expired storm warning dropped
  assert.equal(fmtMeteo(w.meteoFor(poz)[0]), "Silny wiatr – 2. stopień (80%) do odwołania");
  assert.equal(w.hydroFor(poz).length, 0); // drought ignored
  assert.equal(w.hydroFor(krk).length, 1);
  w.load({ message: "Brak ostrzeżeń meteorologicznych" }, []);
  assert.equal(w.meteo.length, 0);
});
