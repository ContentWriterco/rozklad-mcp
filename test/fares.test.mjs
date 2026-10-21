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
  assert.equal(f.quote("IC", "IC", 70, [])?.class2, 33);
  assert.equal(f.quote("IC", "IC", 70, [])?.class2Max, undefined);
  assert.equal(f.quote("IC", "TLK", 200, [])?.class1, 90);
  assert.equal(f.quote("IC", "IC", 200.2, [])?.basis, "~200 km");
  // near a band boundary (100/101 km): range
  const q = f.quote("IC", "IC", 99.6, []);
  assert.equal(q?.class2, 33);
  assert.equal(q?.class2Max, 69);
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

const regFile = join(dir, "regional.json");
writeFileSync(
  regFile,
  JSON.stringify({
    carriers: [
      {
        agency_id: "PR",
        carrier: "Test Regio",
        valid_from: "2024-12-15",
        source: "https://example.org/tpr.pdf",
        tables: [
          { name: "IR", categories: ["IR"], rows: [[1, 40, 16.5], [41, 59, 22.3]] },
          { name: "REGIO", categories: ["*"], rows: [[1, 5, 6.1], [6, 10, 6.7], [11, 15, 7.9]] },
        ],
        exclude_stations: ["Lotnisko"],
      },
    ],
  }),
);
const fr = new Fares([regFile]);

test("fares: regional km tables by category, ZKA priced like the train, no 1st class", () => {
  assert.equal(fr.quote("PR", "REG", 8, [])?.class2, 6.7);
  assert.equal(fr.quote("PR", "REG", 8, [])?.class1, undefined);
  assert.equal(fr.quote("PR", "ZKA REG", 13, [])?.class2, 7.9);
  assert.equal(fr.quote("PR", "IR", 13, [])?.class2, 16.5);
  assert.equal(fr.quote("PR", "K3", 3, ["A", "B"])?.class2, 6.1);
  assert.equal(fr.quote("PR", "REG", 3, ["Lotnisko Balice", "B"]), null);
  assert.equal(fr.quote("PR", "REG", 99, []), null);
  assert.equal(fr.quote("KM", "R1", 8, []), null);
});
