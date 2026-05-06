import { SettingsManager, RemoteSettingsManager } from "../src/Settings.mjs";
import fs from "node:fs";
import { logger } from "../src/constants/Logger.mjs";

const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url)));

// Both source and destination use RemoteSettingsManager to ensure the
// `guilds` Map is populated from MySQL.  The abstract SettingsManager base
// class has no implementation (no guilds, no load, no defaults).
const sm = new RemoteSettingsManager(config.mysql, "./storage/defaults.json");
const rsm = new RemoteSettingsManager(config.mysql, "./storage/defaults.json");

// Capture entries after the source manager has loaded from DB.
let servers = [];
sm.on("ready", () => {
  servers = sm.guilds.entries();
});

rsm.on("ready", async () => {
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
