import { readFileSync } from "node:fs";

const file = process.env.HEARTBEAT_FILE || "/tmp/remix-heartbeat";
const maxAgeMs = Number(process.env.HEARTBEAT_MAX_AGE_MS) || 60_000;

try {
  const t = Number(readFileSync(file, "utf8"));
  process.exit(Number.isFinite(t) && Date.now() - t < maxAgeMs ? 0 : 1);
} catch {
  process.exit(1);
}
