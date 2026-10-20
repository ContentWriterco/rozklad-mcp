// Make the CLI entry executable after tsc.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
const f = new URL("../dist/index.js", import.meta.url);
const src = readFileSync(f, "utf8");
if (!src.startsWith("#!")) writeFileSync(f, "#!/usr/bin/env node\n" + src);
chmodSync(f, 0o755);
