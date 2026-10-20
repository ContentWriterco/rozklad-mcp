import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Engine, UserError } from "./engine.js";
import { createServer } from "./server.js";
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

async function startHttp(engine: Engine, port: number, host: string) {
  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
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
      const body = await readBody(req);
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
