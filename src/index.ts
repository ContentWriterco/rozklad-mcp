import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Engine, UserError } from "./engine.js";
import { createServer } from "./server.js";
import { usage } from "./usage.js";
import { landingHtml } from "./landing.js";
import { config, log } from "./config.js";
import { VERSION } from "./version.js";

const HELP = `rozklad-mcp ${VERSION} - Polish train & bus timetables for AI agents (MCP)

Usage:
  rozklad-mcp                      start MCP server on stdio (for Claude, Cursor, VS Code, ...)
  rozklad-mcp --http [--port 3000] [--host 127.0.0.1]
                                   start MCP server over Streamable HTTP at /mcp
  rozklad-mcp update               download / refresh timetables now
  rozklad-mcp sources              show data sources and status
  rozklad-mcp plan <from> <to> [--date D] [--time HH:MM] [--arrive-by] [--transfers N] [--modes train,bus]
  rozklad-mcp departures <station> [--date D] [--time HH:MM] [--direction X] [--duration MIN]
  rozklad-mcp trip <number|ref> [--date D]
  rozklad-mcp stops <query>

Environment:
  ROZKLAD_FEEDS        feeds to load: groups trains,regional,city | ids | city:Poznań | all | -id
                       (default "trains,regional")
  ROZKLAD_EXTRA_FEEDS  your own GTFS zips: "id=https://.../gtfs.zip;id2=..."
  ROZKLAD_CACHE_DIR    cache directory (default: OS cache dir)
  ROZKLAD_REFRESH_HOURS  how often to re-check timetables (default 12)
  ROZKLAD_MIN_TRANSFER default minimum change time in minutes (default 4)
  ROZKLAD_LIVE=0       disable live delays
  ROZKLAD_LOG=debug    verbose logs (stderr)
  ROZKLAD_RATE_LIMIT   HTTP mode: max requests per minute per IP (default off)
  ROZKLAD_STATS        HTTP mode: 1 = anonymous daily usage counters, served at /stats
  ROZKLAD_PLK_API_KEY  key for PKP PLK Otwarte Dane Kolejowe (disruptions, replacement buses)
  ROZKLAD_CONN_CACHE_MB  memory budget for per-day connection tables (default 400)
  ROZKLAD_TRUST_PROXY=1  HTTP mode: take client IP from X-Forwarded-For
`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["http", "arrive-by", "help", "version", "arrivals"].includes(key)) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Simple per-IP fixed-window rate limiter for public instances. */
const RATE = Number(process.env.ROZKLAD_RATE_LIMIT ?? 0); // requests per minute per IP, 0 = off
const TRUST_PROXY = process.env.ROZKLAD_TRUST_PROXY === "1";
const hits = new Map<string, { n: number; reset: number }>();
function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const xf = req.headers["x-forwarded-for"];
    const v = Array.isArray(xf) ? xf[0] : xf;
    if (v) return v.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "?";
}
function rateLimited(req: IncomingMessage): boolean {
  if (!RATE) return false;
  const ip = clientIp(req);
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.reset) {
    h = { n: 0, reset: now + 60_000 };
    hits.set(ip, h);
    if (hits.size > 50_000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  }
  return ++h.n > RATE;
}

const LANDING = `rozklad-mcp ${VERSION} - Polish train & bus timetables for AI agents (MCP).
MCP endpoint (Streamable HTTP): POST /mcp
Source, docs, local install: https://github.com/ContentWriterco/rozklad-mcp
`;

async function startHttp(engine: Engine, port: number, host: string) {
  const httpServer = createHttpServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, accept, mcp-protocol-version, mcp-session-id, authorization");
    res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/") {
        const accept = String(req.headers.accept ?? "");
        if (accept.includes("text/html")) {
          const proto = TRUST_PROXY ? String(req.headers["x-forwarded-proto"] ?? "https").split(",")[0] : "http";
          const base = process.env.ROZKLAD_PUBLIC_URL ?? `${proto}://${req.headers.host ?? "localhost"}`;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=600" });
          res.end(landingHtml(base.replace(/\/$/, ""), usage.enabled));
        } else {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(LANDING);
        }
        return;
      }
      if (url.pathname === "/stats" && usage.enabled) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "max-age=300" });
        res.end(JSON.stringify(await usage.summary(), null, 1));
        return;
      }
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: VERSION, loaded: !!engine.net }));
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("rozklad-mcp: MCP endpoint is /mcp\n");
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      if (rateLimited(req)) {
        void usage.request(clientIp(req), undefined, true);
        res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: `Rate limit: ${RATE} requests/minute. Run rozklad-mcp locally for heavier use.` }, id: null }));
        return;
      }
      const body = await readBody(req);
      if (usage.enabled) {
        const msgs = (Array.isArray(body) ? body : [body]) as { method?: string; params?: { clientInfo?: { name?: string } } }[];
        const init = msgs.find((m) => m?.method === "initialize");
        void usage.request(clientIp(req), init ? (init.params?.clientInfo?.name ?? "unknown") : undefined);
      }
      // Stateless: a fresh MCP server per request, sharing the loaded timetable.
      const server = createServer(engine);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log("error", (e as Error).message);
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: (e as Error).message }, id: null }));
      }
    }
  });
  usage.start();
  httpServer.listen(port, host, () => log("info", `HTTP MCP endpoint: http://${host}:${port}/mcp`));
  // warm up in the background so the first request is fast
  engine.ready().catch((e) => log("error", e.message));
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || pos[0] === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (flags.version) {
    process.stdout.write(VERSION + "\n");
    return;
  }
  const engine = new Engine();
  const cmd = pos[0];
  const out = (s: string) => process.stdout.write(s + "\n");
  const opt = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);

  try {
    switch (cmd) {
      case undefined:
        if (flags.http) {
          await startHttp(engine, Number(opt("port") ?? process.env.PORT ?? 3000), opt("host") ?? process.env.HOST ?? "127.0.0.1");
        } else {
          const server = createServer(engine);
          await server.connect(new StdioServerTransport());
          log("info", `rozklad-mcp ${VERSION} on stdio; feeds: ${config.feeds}`);
          // start loading right away; tools await it
          engine.ready().catch((e) => log("error", e.message));
        }
        return;
      case "update":
        await engine.ready();
        out(await engine.refreshNow(true));
        out(await engine.sources());
        return;
      case "sources":
        await engine.ready();
        out(await engine.sources());
        return;
      case "plan":
        if (pos.length < 3) throw new UserError("usage: rozklad-mcp plan <from> <to>");
        out(
          await engine.plan({
            from: pos[1],
            to: pos[2],
            date: opt("date"),
            time: opt("time"),
            arriveBy: !!flags["arrive-by"],
            maxTransfers: opt("transfers") ? Number(opt("transfers")) : undefined,
            modes: opt("modes")?.split(","),
            results: opt("results") ? Number(opt("results")) : undefined,
          }),
        );
        return;
      case "departures":
        if (pos.length < 2) throw new UserError("usage: rozklad-mcp departures <station>");
        out(
          await engine.departures({
            station: pos[1],
            date: opt("date"),
            time: opt("time"),
            direction: opt("direction"),
            durationMinutes: opt("duration") ? Number(opt("duration")) : undefined,
            arrivals: !!flags.arrivals,
            modes: opt("modes")?.split(","),
          }),
        );
        return;
      case "trip":
        if (pos.length < 2) throw new UserError("usage: rozklad-mcp trip <number|ref>");
        out(await engine.tripDetails(pos[1].includes("@") ? { ref: pos[1] } : { train: pos.slice(1).join(" "), date: opt("date") }));
        return;
      case "stops":
        out(await engine.findStops(pos.slice(1).join(" "), 15));
        return;
      default:
        throw new UserError(`unknown command "${cmd}". Try --help.`);
    }
  } catch (e) {
    process.stderr.write((e instanceof UserError ? e.message : (e as Error).stack) + "\n");
    process.exitCode = 1;
  }
}

void main();
