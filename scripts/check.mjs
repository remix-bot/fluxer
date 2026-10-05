/**
 * Fast project gate for CI and local use (`npm run check`):
 *   1. every .mjs file parses            (node --check)
 *   2. every module links                (catches broken imports / missing exports without starting the bot)
 *   3. every JSON file is valid
 *   4. all translations have exactly the keys of en.json
 * Exits 1 on any failure.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".git", "test", "scripts"]);
const ENTRY_POINTS = new Set(["index.mjs", "shard.mjs", "settings/migrate.mjs", "settings/runnables.mjs", "docker/healthcheck.mjs"]);

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}
const rel = (p) => relative(root, p).split("\\").join("/");
const failures = [];

const mjs = walk(root, ".mjs").map(rel).sort();
for (const f of mjs) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) failures.push(`syntax  ${f}: ${(r.stderr || "").split("\n").find((l) => l.trim()) ?? "error"}`);
}
console.log(`syntax    ${mjs.length} files checked`);

let linked = 0;
const realExit = process.exit;
process.exit = (code) => { throw new Error(`called process.exit(${code}) while being imported`); };
for (const f of mjs.filter((f) => !ENTRY_POINTS.has(f))) {
  try { await import(pathToFileURL(join(root, f)).href); linked++; }
  catch (e) { failures.push(`link    ${f}: ${String(e.message).split("\n")[0]}`); }
}
process.exit = realExit;
console.log(`link      ${linked} modules loaded`);

const jsons = walk(root, ".json").map(rel).sort();
for (const f of jsons) {
  try { JSON.parse(readFileSync(join(root, f), "utf8")); }
  catch (e) { failures.push(`json    ${f}: ${e.message}`); }
}
console.log(`json      ${jsons.length} files checked`);

const localeDir = join(root, "storage", "locales", "bot");
try {
  const flat = (o, p = "", out = {}) => { for (const [k, v] of Object.entries(o)) { const key = p ? p + "." + k : k; v && typeof v === "object" && !Array.isArray(v) ? flat(v, key, out) : (out[key] = v); } return out; };
  const load = (f) => flat(JSON.parse(readFileSync(join(localeDir, f), "utf8")));
  const base = load("en.json");
  let locales = 0;
  for (const f of readdirSync(localeDir).filter((f) => f.endsWith(".json") && f !== "en.json")) {
    const d = load(f); locales++;
    const missing = Object.keys(base).filter((k) => !(k in d));
    if (missing.length) failures.push(`locale  ${f}: ${missing.length} key(s) missing, e.g. ${missing.slice(0, 3).join(", ")}`);
  }
  console.log(`locales   ${locales} translations compared with en.json (${Object.keys(base).length} keys)`);
} catch (e) { failures.push(`locale  could not compare translations: ${e.message}`); }

if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n  ` + failures.join("\n  "));
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
