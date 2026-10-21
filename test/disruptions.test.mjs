import { test } from "node:test";
import assert from "node:assert/strict";
import { PlkDisruptions, shortMessage } from "../dist/disruptions.js";
import { decodeTripUpdates } from "../dist/gtfsrt.js";

test("disruptions: index PLK API response by train run and station", () => {
  const d = new PlkDisruptions();
  d.load({
    generatedAt: "2026-10-21T10:00:00Z",
    disruptionTypes: { utr_32: "Zastępcza komunikacja autobusowa" },
    stations: { 1: "Kraków Główny", 2: "Wieliczka Rynek-Kopalnia", 3: "Kraków Bieżanów" },
    disruptions: [
      {
        disruptionId: 7,
        disruptionTypeCode: "utr_32",
        startStationId: 1,
        endStationId: 2,
        message: "Na odcinku   Kraków Główny - Wieliczka kursuje ZKA.",
        affectedRoutes: [{ scheduleId: 2026, orderId: 123456789, operatingDate: "2026-10-21T00:00:00", stationId: 3 }],
      },
    ],
  });
  assert.equal(d.count, 1);
  assert.equal(d.forTrip("PLK_KML_2026_123456789", "2026-10-21").length, 1);
  assert.equal(d.forTrip("PLK_KML_2026_123456789_LEG1", "2026-10-21").length, 1);
  assert.equal(d.forTrip("PLK_KML_2026_123456789", "2026-10-22").length, 0);
  assert.equal(d.search("Bieżanów").length, 1);
  assert.equal(d.search("Gdynia").length, 0);
  assert.match(shortMessage(d.search()[0]), /^Zastępcza komunikacja autobusowa \(Kraków Główny – Wieliczka Rynek-Kopalnia\): Na odcinku Kraków/);
});

// hand-encoded GTFS-RT: header(ts) + entity{trip_update{trip{trip_id "T1", start_date "20261021"}, stu{seq 3, arrival{delay -90}}, stu{stop_id "S9", departure{time ...}}}}
function varint(n) {
  const out = [];
  let v = BigInt.asUintN(64, BigInt(n));
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
const str = (f, s) => [(f << 3) | 2, ...varint(Buffer.byteLength(s)), ...Buffer.from(s)];
const msg = (f, bytes) => [(f << 3) | 2, ...varint(bytes.length), ...bytes];
const num = (f, n) => [(f << 3) | 0, ...varint(n)];

test("gtfs-rt: decodes trip updates incl. negative delays and stop ids", () => {
  const trip = msg(1, [...str(1, "T1"), ...str(3, "20261021"), ...num(4, 0)]);
  const stu1 = msg(2, [...num(1, 3), ...msg(2, num(1, -90))]);
  const stu2 = msg(2, [...msg(3, num(2, 1792577770)), ...str(4, "S9"), ...num(5, 1)]);
  const entity = msg(2, [...str(1, "e1"), ...msg(3, [...trip, ...stu1, ...stu2, ...num(5, 120)])]);
  const header = msg(1, [...str(1, "2.0"), ...num(3, 1792577000)]);
  const feed = decodeTripUpdates(new Uint8Array([...header, ...entity]));
  assert.equal(feed.timestamp, 1792577000);
  assert.equal(feed.trips.length, 1);
  const t = feed.trips[0];
  assert.equal(t.tripId, "T1");
  assert.equal(t.startDate, "20261021");
  assert.equal(t.delay, 120);
  assert.deepEqual(t.stops[0], { rel: 0, seq: 3, arrDelay: -90, arrTime: undefined });
  assert.equal(t.stops[1].stopId, "S9");
  assert.equal(t.stops[1].depTime, 1792577770);
  assert.equal(t.stops[1].rel, 1);
});
