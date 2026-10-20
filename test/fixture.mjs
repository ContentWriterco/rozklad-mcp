// Builds a tiny synthetic GTFS network for tests (no network access needed).
import { zipSync, strToU8 } from "fflate";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/*
  Stations:   Alfa (train)  --T1 08:00-09:00-->  Beta (train)
              Beta Bus (bus stop, ~200 m from Beta)  --B1 09:10-09:40--> Delta
              Alfa --T3 07:50-10:30 (slow direct)--> Delta
              Alfa --N1 23:30 -> 24:40 --> Beta (overnight)
*/
export function trainsZip() {
  return zipSync({
    "agency.txt": strToU8("agency_id,agency_name,agency_url,agency_timezone\nKT,Koleje Testowe,https://example.org,Europe/Warsaw\n"),
    "stops.txt": strToU8(
      [
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,platform_code",
        "ALFA,Alfa,52.0000,17.0000,1,,",
        "ALFA_1,Alfa,52.0000,17.0000,0,ALFA,1",
        "BETA,Beta Główna,52.1000,17.1000,1,,",
        "BETA_2,Beta Główna,52.1000,17.1000,0,BETA,2",
        "DELTA_T,Delta,52.2000,17.2000,0,,",
      ].join("\n"),
    ),
    "routes.txt": strToU8("route_id,agency_id,route_short_name,route_long_name,route_type\nR,KT,R,Regio,2\nIC,KT,IC,InterCity,2\n"),
    "calendar.txt": strToU8(
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nD,1,1,1,1,1,1,1,20200101,20991231\n",
    ),
    "trips.txt": strToU8(
      "route_id,service_id,trip_id,trip_short_name,trip_headsign,plk_train_number,plk_train_name\nR,D,T1,1001,Beta Główna,1001,\nIC,D,T3,3510,Delta,3510,TESTOWY\nR,D,N1,1999,Beta Główna,1999,\n",
    ),
    "stop_times.txt": strToU8(
      [
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence,platform",
        "T1,08:00:00,08:00:00,ALFA_1,1,1",
        "T1,09:00:00,09:00:00,BETA_2,2,2",
        // deliberately out of order to test sorting
        "T3,10:30:00,10:30:00,DELTA_T,3,",
        "T3,07:50:00,07:50:00,ALFA_1,1,1",
        "T3,,,BETA_2,2,2",
        "N1,23:30:00,23:30:00,ALFA_1,1,1",
        "N1,24:40:00,24:40:00,BETA_2,2,2",
      ].join("\r\n"),
    ),
  });
}

export function busZip() {
  return zipSync({
    "agency.txt": strToU8("agency_id,agency_name,agency_url,agency_timezone\nPKS,PKS Test,https://example.org,Europe/Warsaw\n"),
    "stops.txt": strToU8(
      [
        "stop_id,stop_name,stop_lat,stop_lon",
        'BB1,"Beta Główna, Dworzec 01",52.1015,17.1005',
        'BB2,"Beta Główna, Dworzec 02",52.1016,17.1006',
        "DD1,Delta Rynek,52.2010,17.2010",
      ].join("\n"),
    ),
    "routes.txt": strToU8("route_id,agency_id,route_short_name,route_long_name,route_type\nL1,PKS,101,Beta - Delta,3\n"),
    "calendar.txt": strToU8(
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nW,1,1,1,1,1,1,1,20200101,20991231\n",
    ),
    "trips.txt": strToU8("route_id,service_id,trip_id,trip_headsign\nL1,W,B1,Delta Rynek\n"),
    "stop_times.txt": strToU8(
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nB1,09:10:00,09:10:00,BB1,1\nB1,09:40:00,09:40:00,DD1,2\n",
    ),
  });
}

/** Writes a registry + cached feeds into dir and returns env vars for the engine. */
export function setupFixture(dir) {
  const feedsDir = join(dir, "feeds");
  mkdirSync(feedsDir, { recursive: true });
  const meta = (id) => JSON.stringify({ url: `fixture:${id}`, fetchedAt: Date.now(), checkedAt: Date.now(), size: 1 });
  writeFileSync(join(feedsDir, "test-trains.zip"), trainsZip());
  writeFileSync(join(feedsDir, "test-trains.meta.json"), meta("test-trains"));
  writeFileSync(join(feedsDir, "test-bus.zip"), busZip());
  writeFileSync(join(feedsDir, "test-bus.meta.json"), meta("test-bus"));
  const registry = {
    feeds: [
      { id: "test-trains", name: "Test trains", group: "trains", url: "https://invalid.example/t.zip", attribution: "Test rail data" },
      { id: "test-bus", name: "Test bus", group: "regional", url: "https://invalid.example/b.zip", attribution: "Test bus data" },
    ],
  };
  writeFileSync(join(dir, "feeds.json"), JSON.stringify(registry));
  return {
    ROZKLAD_CACHE_DIR: dir,
    ROZKLAD_FEEDS_FILE: join(dir, "feeds.json"),
    ROZKLAD_FEEDS: "all",
    ROZKLAD_OFFLINE: "1",
    ROZKLAD_LIVE: "0",
    ROZKLAD_LOG: "error",
    ROZKLAD_MIN_TRANSFER: "4",
  };
}
