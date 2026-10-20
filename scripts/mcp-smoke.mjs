// End-to-end check over real MCP stdio: list tools and call each one.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/index.js", import.meta.url).pathname],
  env: { ...process.env },
  stderr: "ignore",
});
const client = new Client({ name: "smoke", version: "1" });
const t0 = Date.now();
await client.connect(transport);
console.log("connected in", Date.now() - t0, "ms; server:", client.getServerVersion());
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const calls = [
  ["find_stops", { query: "poznan gl" }],
  ["plan_journey", { from: "Zbąszyń", to: "Poznań Główny", results: 2 }],
  ["departures", { station: "Kraków Główny", duration_minutes: 30, limit: 3 }],
  ["trip_details", { train: "3510", date: "tomorrow" }],
  ["nearby_stops", { lat: 52.4012, lon: 16.9114, radius_m: 400 }],
  ["data_sources", {}],
  ["plan_journey", { from: "Atlantyda", to: "Poznań" }],
];
let failed = 0;
for (const [name, args] of calls) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  const expectError = name === "plan_journey" && args.from === "Atlantyda";
  const ok = expectError ? r.isError === true : !r.isError && text.length > 20;
  if (!ok) failed++;
  console.log(`\n### ${name} ${JSON.stringify(args)} -> ${ok ? "OK" : "FAIL"} (${Date.now() - t} ms)\n${text.split("\n").slice(0, 6).join("\n")}`);
}
await client.close();
process.exit(failed ? 1 : 0);
