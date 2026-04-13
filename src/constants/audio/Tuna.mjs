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
        res.on("end", () => { resolve(JSON.parse(Buffer.concat(chunks).toString())); });
        res.on("error", (error) => { rej(error); });
      });
      req.end();
    });
  }
  search(query, page = 1, size = 10) {
    return new Promise(async res => {
      const results = await this.get("/v1/sounds/search", { size, page, search: query });
      results.items = results.items.map(s => {
        s.download = function() {
          return new Promise(resolve => {
            https.get(this.oggPath, (r) => { resolve(r); });
          });
        };
        return s;
      });
      res(results);
    });
  }
  getSound(id) {
    return new Promise(async res => {
      const sound = await this.get("/v1/sounds/" + id);
      sound.download = function() {
        return new Promise(res => {
          https.get(this.oggPath, (result) => { res(result); });
        });
      };
      res(sound);
    });
  }
}

export default Tuna;
