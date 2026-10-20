import { homedir, platform } from "node:os";
import { join } from "node:path";

function defaultCacheDir(): string {
  const home = homedir();
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, "rozklad-mcp");
  if (platform() === "darwin") return join(home, "Library", "Caches", "rozklad-mcp");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "rozklad-mcp", "Cache");
  return join(home, ".cache", "rozklad-mcp");
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  /** Feed selection: groups (trains, regional, city), feed ids, "all", "-id" to exclude. */
  feeds: process.env.ROZKLAD_FEEDS ?? "trains,regional",
  /** Extra custom GTFS feeds: "id=https://...zip;id2=https://...". */
  extraFeeds: process.env.ROZKLAD_EXTRA_FEEDS ?? "",
  /** Alternative registry file (for forks/self-hosting). */
  feedsFile: process.env.ROZKLAD_FEEDS_FILE ?? "",
  cacheDir: process.env.ROZKLAD_CACHE_DIR ?? defaultCacheDir(),
  /** How often the static timetable is re-checked (conditional GET). */
  refreshHours: num("ROZKLAD_REFRESH_HOURS", 12),
  /** Default minimum transfer time in minutes. */
  minTransferMin: num("ROZKLAD_MIN_TRANSFER", 4),
  /** Max walking distance between stops for transfers, metres. */
  maxWalkMeters: num("ROZKLAD_MAX_WALK_M", 500),
  /** Live data cache, seconds. */
  liveTtlSec: num("ROZKLAD_LIVE_TTL", 90),
  /** Disable live (realtime) lookups entirely. */
  liveEnabled: process.env.ROZKLAD_LIVE !== "0",
  /** Never download (use only what is cached) - handy for tests/CI. */
  offline: process.env.ROZKLAD_OFFLINE === "1",
  log: process.env.ROZKLAD_LOG ?? "info",
  userAgent: "rozklad-mcp/0.1 (+https://github.com/ContentWriterco/rozklad-mcp)",
};

export function log(level: "debug" | "info" | "warn" | "error", ...args: unknown[]) {
  const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const cur = order[(config.log as keyof typeof order) ?? "info"] ?? 1;
  if (order[level] < cur) return;
  // stdout is reserved for the MCP protocol - always log to stderr.
  console.error(`[rozklad-mcp] ${level}:`, ...args);
}
