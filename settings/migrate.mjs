import { SettingsManager, RemoteSettingsManager } from "../src/Settings.mjs";
import fs from "node:fs";
import { logger } from "../src/constants/Logger.mjs";

const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url)));

// Pass bot ID from config if available, so migrations are bot-isolated.
// If no botId in config, all rows are migrated (legacy behavior).
const botId = config.botId ?? null;

// Both source and destination use RemoteSettingsManager to ensure the
// `guilds` Map is populated from MySQL.  The abstract SettingsManager base
// class has no implementation (no guilds, no load, no defaults).
const sm = new RemoteSettingsManager(config.mysql, "./storage/defaults.json", botId);
const rsm = new RemoteSettingsManager(config.mysql, "./storage/defaults.json", botId);

// Ensure source manager is fully loaded BEFORE starting migration.
// Previously, rsm's "ready" could fire before sm finished loading,
// resulting in an empty servers array and a silent no-op migration.
let migrationStarted = false;

sm.on("ready", async () => {
  if (migrationStarted) return;
  migrationStarted = true;

  const servers = [...sm.guilds.entries()];

  // Wait for the destination manager to be ready too
  if (!rsm.guilds.size) {
    await new Promise(resolve => rsm.on("ready", resolve));
  }

  for (const [id, s] of servers) {
    logger.settings("[migrate] Processing server:", id);
    if (rsm.hasServer(id)) {
      await rsm.remoteSave(s);
      continue;
    }
    await rsm.create(id, s);
  }
  process.exit(0);
});
