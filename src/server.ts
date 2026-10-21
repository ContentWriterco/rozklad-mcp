import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Engine, UserError } from "./engine.js";
import { log } from "./config.js";
import { VERSION } from "./version.js";

const modes = z
  .array(z.enum(["train", "bus", "tram", "metro", "ferry", "all"]))
  .optional()
  .describe('Restrict to these modes, e.g. ["train"] or ["train","bus"]. Default: all loaded.');

const date = z
  .string()
  .optional()
  .describe('Date: "YYYY-MM-DD", "today", "tomorrow", a weekday ("friday", "piątek") or "DD.MM". Default: today.');

const time = z.string().optional().describe('Local time "HH:MM" (Europe/Warsaw). Default: now (today) or 04:00 (other days).');

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<string>): Promise<Text> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (e) {
    const msg = e instanceof UserError ? e.message : `Internal error: ${(e as Error).message}`;
    if (!(e instanceof UserError)) log("error", (e as Error).stack);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

export const INSTRUCTIONS = `Polish public transport timetables (open data): all trains in Poland (PKP Intercity, Polregio, Koleje Mazowieckie, SKM, Koleje Śląskie/Dolnośląskie/Wielkopolskie/Małopolskie, ŁKA, Arriva, RegioJet, Leo Express, WKD), PKS / regional buses where carriers publish data, and optionally city transit.
Typical flow: plan_journey(from, to, date, time) answers most questions directly - station and town names are matched fuzzily (with or without Polish letters). Use departures for "what leaves X now", trip_details for a specific train (number like 3510 or a ref) incl. live delays, find_stops/nearby_stops when a place is unclear (you can pass "lat,lon" as from/to).
Times are local Europe/Warsaw. Live delays cover trains only. For PKP Intercity trains plan_journey shows the published price-list price: it is the MAXIMUM full-fare price, the actual price in sale is often lower (discounts, promotions) - say so when quoting it. Other carriers' prices are not available yet. Mention that data comes from the listed sources when relevant.`;

export function createServer(engine: Engine): McpServer {
  const server = new McpServer({ name: "rozklad-mcp", version: VERSION }, { instructions: INSTRUCTIONS });
  const ro = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "plan_journey",
    {
      title: "Plan a journey (train / bus)",
      description:
        "Find connections between two places in Poland, including changes between trains and buses (PKS). " +
        "from/to accept a station name (\"Poznań Główny\"), a town (\"Zakopane\" = all its stops) or coordinates \"52.40,16.91\". " +
        "Returns several options with times, platforms, operators, changes and live delays (today).",
      inputSchema: {
        from: z.string().describe("Origin: station, town or 'lat,lon'"),
        to: z.string().describe("Destination: station, town or 'lat,lon'"),
        date,
        time,
        arrive_by: z.boolean().optional().describe("If true, `time` is the latest arrival time instead of the earliest departure."),
        max_transfers: z.number().int().min(0).max(6).optional().describe("Maximum number of changes (default 3, 0 = direct only)."),
        min_transfer_minutes: z.number().min(0).max(60).optional().describe("Minimum time for a change (default 4)."),
        modes,
        results: z.number().int().min(1).max(10).optional().describe("Number of options (default 5)."),
        live: z.boolean().optional().describe("Include live delays (default true)."),
      },
      annotations: ro,
    },
    async (a) =>
      run(() =>
        engine.plan({
          from: a.from,
          to: a.to,
          date: a.date,
          time: a.time,
          arriveBy: a.arrive_by,
          maxTransfers: a.max_transfers,
          minTransferMinutes: a.min_transfer_minutes,
          modes: a.modes,
          results: a.results,
          live: a.live,
        }),
      ),
  );

  server.registerTool(
    "departures",
    {
      title: "Station departures / arrivals board",
      description:
        "Departure (or arrival) board for a station or stop: time, live delay, train/bus line, platform, destination and main stops. " +
        "Optionally only services going towards a given place.",
      inputSchema: {
        station: z.string().describe("Station or stop name, e.g. 'Kraków Główny', 'Zbąszyń'"),
        date,
        time,
        duration_minutes: z.number().int().min(10).max(1440).optional().describe("Time window (default 120)."),
        direction: z.string().optional().describe("Only services that later call at this place, e.g. 'Poznań'."),
        arrivals: z.boolean().optional().describe("Show arrivals instead of departures."),
        modes,
        limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 30)."),
        live: z.boolean().optional(),
      },
      annotations: ro,
    },
    async (a) =>
      run(() =>
        engine.departures({
          station: a.station,
          date: a.date,
          time: a.time,
          durationMinutes: a.duration_minutes,
          direction: a.direction,
          arrivals: a.arrivals,
          modes: a.modes,
          limit: a.limit,
          live: a.live,
        }),
      ),
  );

  server.registerTool(
    "trip_details",
    {
      title: "Train / trip details with live delay",
      description:
        "All stops of one train or bus run with times, platforms and live delays/cancellations. " +
        "Identify it by `ref` (from plan_journey/departures) or by train number/name (e.g. '3510', 'IC 3510', 'Podhalanin') plus date.",
      inputSchema: {
        ref: z.string().optional().describe("Trip ref like 'polish-trains:PLK_IC_2026_123@2026-10-20'"),
        train: z.string().optional().describe("Train number or name"),
        date,
        live: z.boolean().optional(),
      },
      annotations: ro,
    },
    async (a) => run(() => engine.tripDetails(a)),
  );

  server.registerTool(
    "find_stops",
    {
      title: "Find stations and stops",
      description: "Search stations/stops by name (fuzzy, diacritics optional). Shows modes, coordinates and source feeds.",
      inputSchema: {
        query: z.string().describe("Name or part of it, e.g. 'warszawa centr', 'Szklarska'"),
        limit: z.number().int().min(1).max(50).optional(),
        modes,
      },
      annotations: ro,
    },
    async (a) => run(() => engine.findStops(a.query, a.limit, a.modes)),
  );

  server.registerTool(
    "nearby_stops",
    {
      title: "Stops near a location",
      description: "Stations and stops within a radius of coordinates (e.g. after geocoding an address).",
      inputSchema: {
        lat: z.number().min(48).max(56),
        lon: z.number().min(13).max(25),
        radius_m: z.number().int().min(50).max(5000).optional().describe("Default 800 m"),
        modes,
      },
      annotations: ro,
    },
    async (a) => run(() => engine.nearbyStops(a.lat, a.lon, a.radius_m, a.modes)),
  );

  server.registerTool(
    "data_sources",
    {
      title: "Data sources, coverage and licences",
      description: "Which carriers/feeds are loaded, their validity dates, licences and required attribution; which feeds can be enabled.",
      inputSchema: {},
      annotations: ro,
    },
    async () => run(() => engine.sources()),
  );

  server.registerPrompt(
    "plan_trip",
    {
      title: "Plan a trip in Poland",
      description: "Plan a door-to-door trip by train/bus",
      argsSchema: { from: z.string(), to: z.string(), when: z.string().optional() },
    },
    ({ from, to, when }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Plan my trip from ${from} to ${to}${when ? ` (${when})` : ""}. Use plan_journey, compare the options (duration, changes, delays) and recommend one. If a stop is unclear, use find_stops first.`,
          },
        },
      ],
    }),
  );

  return server;
}
