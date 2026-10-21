import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fares } from "../dist/fares.js";

const dir = mkdtempSync(join(tmpdir(), "fares-"));
const file = join(dir, "t.json");
writeFileSync(
  file,
  JSON.stringify({
    carrier: "Test IC",
    agency_id: "IC",
    source: "https://example.org/cennik.pdf",
    valid_from: "2026-07-23",
    multi_station_cities: ["Poznań", "Warszawa", "Kraków"],
    distance_bands: { categories: ["TLK", "IC"], rows: [[1, 40, 15, 23], [41, 100, 33, 43], [101, 310, 69, 90]] },
    pairs: {
      EIC: { rows: [["Poznań", "Warszawa", [], 149, 214]] },
      EIP: { rows: [["Poznań", "Warszawa", [], 169, 259], ["Poznań", "Warszawa", ["Katowice"], 180, 269]] },
    },
  }),
);
const f = new Fares([file]);

test("fares: km bands for TLK/IC (rounded km)", () => {
  assert.equal(f.quote("IC", "IC", 100.4, [])?.class2, 33);
  assert.equal(f.quote("IC", "TLK", 303.03, [])?.class1, 90);
  assert.equal(f.quote("IC", "IC", 303.03, [])?.basis, "303 km");
  assert.equal(f.quote("IC", "IC", null, []), null);
  assert.equal(f.quote("KM", "IC", 50, []), null);
});

test("fares: station pairs map multi-station cities and pick the matching via row", () => {
  assert.equal(f.quote("IC", "EIC", null, ["Warszawa Wschodnia", "Konin", "Poznań Główny"])?.class2, 149);
  assert.equal(f.quote("IC", "EIP", null, ["Poznań Główny", "Konin", "Warszawa Centralna"])?.class2, 169);
  assert.equal(f.quote("IC", "EIP", null, ["Poznań Główny", "Katowice", "Warszawa Centralna"])?.class2, 180);
  assert.equal(f.quote("IC", "EIC", null, ["Poznań Główny", "Poznań Garbary"]), null);
  assert.equal(Fares.stationKey("Kraków Płaszów", ["Kraków"]), "krakow");
  assert.equal(Fares.stationKey("Krakówek", ["Kraków"]), "krakowek");
});
