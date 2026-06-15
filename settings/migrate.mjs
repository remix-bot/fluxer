/**
 * @file migrate.mjs — Migration script — migrates settings and 24/7 channel data between Redis and SQLite backends
 * @module settings.migrate
 */

import { RemoteSettingsManager } from "../src/Settings.mjs";
import fs from "node:fs";
import { logger } from "../src/constants/Logger.mjs";

const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url)));

const botId = config.botId ?? null;

const sm = new RemoteSettingsManager(config.mysql, "./storage/defaults.json", botId);
const rsm = new RemoteSettingsManager(config.mysql, "./storage/defaults.json", botId);

let migrationStarted = false;

sm.on("ready", async () => {
  if (migrationStarted) return;
  migrationStarted = true;

  const servers = [...sm.guilds.entries()];

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
