import fs from "node:fs";
import mysql from "mysql";
import { EventEmitter } from "node:events";

export class ServerSettings {
  id;
  manager;
  data = {};

  constructor(id, mgr) {
    this.id = id;
    this.manager = mgr;
    this.loadDefaults();
  }
  set(key, value) { this.data[key] = value; this.manager.update(this, key); }
  get(key) { return this.data[key]; }
  reset(key) { return this.set(key, this.manager.defaults[key]); }
  getAll() { return this.data; }
  loadDefaults() { for (let key in this.manager.defaults) { this.data[key] = this.manager.defaults[key]; } }
  deserialize(json) { for (let k in json) { if (k === "id") continue; this.data[k] = json[k]; } }
  checkDefaults(d) { for (let key in d) { if (!this.data[key]) this.data[key] = d[key]; } }
  get serializationData() { return { ...this.data, id: this.id }; }
  serialize() { return this.serializationData; }
  serializeObject() { return this.serializationData; }
}

/** @deprecated Use RemoteSettingsManager instead */
export class SettingsManager {
  guilds = new Map();
  storagePath = "./storage/settings.json";
  defaults = {};
  descriptions = {};

  constructor(storagePath = null) {
    if (storagePath) this.storagePath = storagePath;
    this.load();
  }
  loadDefaultsSync(filePath) {
    const d = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(d);
    this.descriptions = parsed.descriptions;
    this.defaults = parsed.values;
  }
  load() {
    if (!fs.existsSync(this.storagePath)) {
      fs.writeFileSync(this.storagePath, JSON.stringify({ guilds: [] }));
    }
    const json = JSON.parse(fs.readFileSync(this.storagePath, "utf8"));
    const entries = json.guilds || json.servers || [];
    entries.forEach((s) => {
      const server = new ServerSettings(s.id, this);
      server.deserialize(s);
      server.checkDefaults(this.defaults);
      this.guilds.set(s.id, server);
    });
  }
  save() {
    const s = [];
    this.guilds.forEach((val) => { s.push(val.serialize()); });
    fs.writeFileSync(this.storagePath, JSON.stringify({ guilds: s }));
  }
  saveAsync() {
    return new Promise((res) => {
      const s = [];
      this.guilds.forEach((val) => { s.push(val.serializeObject()); });
      fs.writeFile(this.storagePath, JSON.stringify({ guilds: s }), () => { res(); });
    });
  }
  update(server, key) {
    if (!this.guilds.has(server.id)) this.guilds.set(server.id, server);
    const s = this.guilds.get(server.id);
    s.data[key] = server.data[key];
  }
  isOption(key) { return key in this.defaults; }
  hasServer(id) { return this.guilds.has(id); }
  getServer(id) { return (!this.guilds.has(id)) ? new ServerSettings(id, this) : this.guilds.get(id); }
}

export class RemoteSettingsManager extends EventEmitter {
  guilds = new Map();
  descriptions = {};
  defaults = {};
  db = null;

  constructor(config, defaultsPath) {
    super();
    this.db = mysql.createPool({ connectionLimit: 15, ...config });
    if (defaultsPath) this.loadDefaultsSync(defaultsPath);
    this.load();
  }
  query(q) {
    return new Promise(res => {
      this.db.query(q, (error, results, fields) => { res({ error, results, fields }); });
    });
  }
  async load() {
    const res = await this.query("SELECT * FROM settings");
    if (res.error) {
      console.error("settings init error; ", res.error, "\nretrying in 2 seconds");
      return setTimeout(() => { this.load(); }, 2000);
    }
    res.results.forEach((r) => {
      const server = new ServerSettings(r.id, this);
      server.deserialize(JSON.parse(r.data));
      server.checkDefaults(this.defaults);
      this.guilds.set(server.id, server);
    });
    this.emit("ready");
  }
  async remoteUpdate(server, key) {
    const r = await this.query(`UPDATE settings SET data = JSON_SET(data, '$.${key}', '${server.data[key]}') WHERE id='${server.id}'`);
    if (r.error) console.error("settings update error; ", r.error);
  }
  async remoteSave(server) {
    const r = await this.query(`UPDATE settings SET data = '${JSON.stringify(server.data)}' WHERE id='${server.id}'`);
    if (r.error) console.error("settings server save error; ", r.error);
  }
  loadDefaultsSync(filePath) {
    const d = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(d);
    this.descriptions = parsed.descriptions;
    this.defaults = parsed.values;
  }
  saveAsync() {
    return new Promise(async (res) => {
      const p = [];
      this.guilds.forEach((val) => { p.push(this.remoteSave(val)); });
      await Promise.allSettled(p);
      res();
    });
  }
  async create(id, server) {
    const r = await this.query(`INSERT INTO settings (id, data) VALUES ('${id}', '${JSON.stringify(server.data)}')`);
    if (r.error) console.error("settings create server error; ", r.error);
  }
  update(server, key) {
    if (!this.guilds.has(server.id)) { this.guilds.set(server.id, server); this.create(server.id, server); }
    const s = this.guilds.get(server.id);
    s.data[key] = server.data[key];
    this.remoteUpdate(server, key);
  }
  isOption(key) { return key in this.defaults; }
  hasServer(id) { return this.guilds.has(id); }
  getServer(id) { return (!this.guilds.has(id)) ? new ServerSettings(id, this) : this.guilds.get(id); }
}
