import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, CsvStream } from "../dist/csv.js";
import { normalize, tokens, matchScore } from "../dist/text.js";
import { parseDateInput, parseTimeInput, hhmm, dayNumber, ymdFromDay } from "../dist/time.js";

test("csv: quotes, escaped quotes, CRLF, BOM, empty fields", () => {
  const t = parseCsv('﻿a,b,c\r\n1,"x, ""y""",\r\n2,z,3\n');
  const rows = [];
  t.forEach((r, c) => rows.push([r[c("a")], r[c("b")], r[c("c")]]));
  assert.deepEqual(t.header, ["a", "b", "c"]);
  assert.deepEqual(rows, [
    ["1", 'x, "y"', ""],
    ["2", "z", "3"],
  ]);
});

test("csv: streaming gives the same rows for any chunking", () => {
  const text = 'id,name\n1,"Kraków, Główny"\n2,"Multi\nline"\n3,Zbąszyń\n';
  const expected = [];
  parseCsv(text).forEach((r) => expected.push(r.join("|")));
  for (const size of [1, 2, 3, 5, 7, 100]) {
    const got = [];
    const s = new CsvStream((r) => got.push(r.join("|")));
    for (let i = 0; i < text.length; i += size) s.push(text.slice(i, i + size), i + size >= text.length);
    assert.deepEqual(got, expected, `chunk size ${size}`);
  }
});

test("text: Polish normalisation and matching", () => {
  assert.equal(normalize("Zbąszyń, Łódź Kaliska"), "zbaszyn lodz kaliska");
  assert.deepEqual(tokens("Kraków Gł."), ["krakow", "glowny"]);
  assert.equal(matchScore(tokens("Krakow Glowny"), tokens("Kraków Główny")), 100);
  assert.ok(matchScore(tokens("Kraków"), tokens("Kraków Płaszów")) >= 85);
  assert.ok(matchScore(tokens("warszawa centr"), tokens("Warszawa Centralna")) >= 55);
  assert.ok(matchScore(tokens("Szklrska Poreba"), tokens("Szklarska Poręba Górna")) > 0);
  assert.equal(matchScore(tokens("Gdynia"), tokens("Kraków Główny")), 0);
});

test("time: date and time inputs", () => {
  const today = dayNumber(2026, 10, 20); // Tuesday
  assert.equal(parseDateInput("today", today), today);
  assert.equal(parseDateInput("jutro", today), today + 1);
  assert.equal(parseDateInput("2026-12-24", today), dayNumber(2026, 12, 24));
  assert.equal(parseDateInput("24.12", today), dayNumber(2026, 12, 24));
  assert.equal(parseDateInput("piątek", today), dayNumber(2026, 10, 23));
  assert.equal(parseDateInput("tuesday", today), today);
  assert.equal(parseDateInput("nonsense", today), null);
  assert.equal(parseTimeInput("7:05", 0), 7 * 3600 + 5 * 60);
  assert.equal(parseTimeInput("18", 0), 18 * 3600);
  assert.equal(hhmm(25 * 3600 + 60), "01:01(+1)");
  assert.equal(ymdFromDay(today), "2026-10-20");
});

test("slug: Koleo-style station slugs", async () => {
  const { slug } = await import("../dist/engine.js");
  assert.equal(slug("Poznań Główny"), "poznan-glowny");
  assert.equal(slug("Bielsko-Biała Główna"), "bielsko-biala-glowna");
  assert.equal(slug("Łódź Fabryczna"), "lodz-fabryczna");
});
