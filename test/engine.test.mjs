import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupFixture } from "./fixture.mjs";

let engine;
before(async () => {
  const env = setupFixture(mkdtempSync(join(tmpdir(), "rozklad-test-")));
  Object.assign(process.env, env);
  const { Engine } = await import("../dist/engine.js");
  engine = new Engine();
  await engine.ready();
});

test("loads both feeds and groups bus posts into one station", () => {
  const net = engine.net;
  assert.equal(net.feeds.length, 2);
  const beta = net.stations.filter((s) => s.name.startsWith("Beta Główna"));
  // train station + bus station ("Dworzec 01/02" grouped)
  assert.equal(beta.length, 2);
  assert.ok(beta.some((s) => s.stops.length === 2));
});

test("plan: train + walk + bus beats slow direct train; both are offered", async () => {
  const out = await engine.plan({ from: "Alfa", to: "Delta", time: "07:00", date: "tomorrow" });
  assert.match(out, /08:00 → 09:40 · 1h40 · 1 change/);
  assert.match(out, /07:50 → 10:30 · 2h40 · direct/);
  assert.match(out, /walk \d+ min to Beta Główna, Dworzec 01/);
  assert.match(out, /bus 101 \(PKS Test\)/);
  assert.match(out, /platform 1/);
});

test("plan: max_transfers 0 gives only the direct train", async () => {
  const out = await engine.plan({ from: "Alfa", to: "Delta", time: "07:00", date: "tomorrow", maxTransfers: 0 });
  assert.match(out, /direct/);
  assert.doesNotMatch(out, /1 change/);
});

test("plan: arrive_by returns connections arriving before the deadline", async () => {
  const out = await engine.plan({ from: "Alfa", to: "Delta", time: "10:00", date: "tomorrow", arriveBy: true });
  assert.match(out, /→ 09:40/);
  assert.doesNotMatch(out, /→ 10:30/);
});

test("plan: overnight train arrives after midnight (+1)", async () => {
  const out = await engine.plan({ from: "Alfa", to: "Beta Główna", time: "23:00", date: "tomorrow", modes: ["train"] });
  assert.match(out, /23:30 → 00:40\(\+1\)/);
});

test("arrivals after midnight include the previous day's run", async () => {
  const out = await engine.departures({ station: "Beta Główna", time: "00:00", date: "tomorrow", arrivals: true, modes: ["train"] });
  assert.match(out, /00:40 train R 1999/);
});

test("plan: unknown place is a clear user error", async () => {
  await assert.rejects(engine.plan({ from: "Atlantyda", to: "Delta" }), /No stop or station matches/);
});

test("departures with direction filter", async () => {
  const out = await engine.departures({ station: "Alfa", time: "07:00", date: "tomorrow", durationMinutes: 180, direction: "Delta" });
  assert.match(out, /07:50/);
  assert.doesNotMatch(out, /08:00 train/);
});

test("trip_details by number interpolates missing times", async () => {
  const out = await engine.tripDetails({ train: "IC 3510", date: "tomorrow" });
  assert.match(out, /train IC 3510 TESTOWY/);
  assert.match(out, /09:10\s+Beta Główna/);
});

test("find_stops and data_sources", async () => {
  assert.match(await engine.findStops("beta"), /Beta Główna/);
  const src = await engine.sources();
  assert.match(src, /test-trains/);
  assert.match(src, /Test bus data/);
});
