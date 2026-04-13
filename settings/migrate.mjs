import { SettingsManager, RemoteSettingsManager } from "./Settings.mjs";
import fs from "node:fs";
import { logger } from "../src/constants/Logger.mjs";

const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url)));

const sm = new SettingsManager();
const rsm = new RemoteSettingsManager(config.mysql);

const servers = sm.guilds.entries();

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
