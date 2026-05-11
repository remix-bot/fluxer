import { https } from "follow-redirects";

class Tuna {
  apiKey = null;
  constructor(auth) {
    this.apiKey = auth.key;
  }
  get(path, params = {}) {
    return new Promise((resolve, rej) => {
      var query = "";
      for (let key in params) {
        query += ((query.length === 0) ? "?" : "&") + key + "=" + encodeURIComponent(params[key]);
      }
      var options = {
        method: "GET",
        hostname: "tuna-api.voicemod.net",
        path: path + query,
        headers: { "x-api-key": this.apiKey },
        maxRedirects: 20
      };
      var req = https.request(options, function(res) {
        var chunks = [];
        res.on("data", (chunk) => { chunks.push(chunk); });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            rej(new Error(`Tuna API JSON parse error: ${e.message}`));
          }
        });
      });
      req.on("error", (error) => { rej(error); });
      req.setTimeout(15_000, () => {
        req.destroy();
        rej(new Error("Tuna API request timeout"));
      });
      req.end();
    });
  }
  search(query, page = 1, size = 10) {
    return this.get("/v1/sounds/search", { size, page, search: query }).then(results => {
      results.items = results.items.map(s => {
        s.download = function() {
          return new Promise((resolve, reject) => {
            const req = https.get(this.oggPath, (r) => { resolve(r); });
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
      sound.download = function() {
        return new Promise((resolve, reject) => {
          const req = https.get(this.oggPath, (result) => { resolve(result); });
          req.on("error", (err) => { reject(err); });
          req.setTimeout(15_000, () => { req.destroy(); reject(new Error("Tuna download timeout")); });
        });
      };
      return sound;
    });
  }
}

export default Tuna;
