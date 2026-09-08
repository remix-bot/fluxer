/** @module constants/audio/Tuna */

import pkg from "follow-redirects";
const { https } = pkg;

/**
 * Client for the Tuna (Voicemod) sound-effect API.
 * @class
 */
class Tuna {
  /** @private */ apiKey = null;

  /**
   * @param {{ key: string }} auth - Object containing the API key.
   */
  constructor(auth) {
    this.apiKey = auth.key;
  }

  /**
   * Perform an authenticated GET request to the Tuna API.
   * @private
   * @async
   * @param {string} path - API path (e.g. `"/v1/sounds/search"`).
   * @param {Object<string, *>} [params={}] - Query-string parameters.
   * @returns {Promise<object>} Parsed JSON response.
   */
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

  /**
   * Search for sound effects. Each result item gains a `download()` method
   * that returns the OGG audio stream.
   * @async
   * @param {string} query - Search term.
   * @param {number} [page=1]
   * @param {number} [size=10]
   * @returns {Promise<object>} Search results with enriched `items` array.
   */
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

  /**
   * Fetch a single sound effect by ID. The returned object gains a `download()`
   * method that returns the OGG audio stream.
   * @async
   * @param {string} id - Sound ID.
   * @returns {Promise<object>} Sound object with `download()` method.
   */
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
