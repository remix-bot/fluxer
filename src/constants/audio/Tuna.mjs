/**
 * @file Tuna.mjs — Tuna — Voicemod Tuna API client for sound effect search and download
 * @module src.constants.audio.Tuna
 */

/**
 * Tuna API client for searching and downloading sound effects
 * from the Voicemod Tuna service (tuna-api.voicemod.net).
 */
import pkg from "follow-redirects";
const { https } = pkg;

class Tuna {
  apiKey = null;
  constructor(auth) {
    this.apiKey = auth.key;
  }
  get(path, params = {}) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams(params).toString();
      const query = qs ? "?" + qs : "";
      const options = {
        method: "GET",
        hostname: "tuna-api.voicemod.net",
        path: path + query,
        headers: { "x-api-key": this.apiKey },
        maxRedirects: 20
      };
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => { chunks.push(chunk); });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(new Error(`Tuna API JSON parse error: ${e.message}`));
          }
        });
      });
      req.on("error", (error) => { reject(error); });
      req.setTimeout(15_000, () => {
        req.destroy();
        reject(new Error("Tuna API request timeout"));
      });
      req.end();
    });
  }
  search(query, page = 1, size = 10) {
    return this.get("/v1/sounds/search", { size, page, search: query }).then(results => {
      results.items = results.items.map(s => {
        const oggPath = s.oggPath;
        s.download = () => {
          return new Promise((resolve, reject) => {
            const req = https.get(oggPath, { maxRedirects: 20 }, (r) => { resolve(r); });
            req.on("error", (err) => { reject(err); });
            req.setTimeout(15_000, () => { req.destroy(); reject(new Error("Tuna download timeout")); });
          });
        };
        return s;
      });
      return results;
    });
  }
  getSound(id) {
    return this.get("/v1/sounds/" + id).then(sound => {
      const oggPath = sound.oggPath;
      sound.download = () => {
        return new Promise((resolve, reject) => {
          const req = https.get(oggPath, { maxRedirects: 20 }, (result) => { resolve(result); });
          req.on("error", (err) => { reject(err); });
          req.setTimeout(15_000, () => { req.destroy(); reject(new Error("Tuna download timeout")); });
        });
      };
      return sound;
    });
  }
}

export default Tuna;
