import { Innertube, UniversalCache } from 'youtubei.js';
import vm from 'node:vm';

class RemixYouTubeProvider {
  constructor() {
    this.yt = null;
  }

  async init() {
    this.yt = await Innertube.create({
      generate_session_locally: true,
      device_category: 'MOBILE',
      client_type: 'ANDROID',
      evaluate: (code) => vm.runInNewContext(code),
      cache: new UniversalCache(false)
    });
    console.log('[Remix] YouTube Provider Initialized (Android Mode)');
  }

  async getPlayableUrl(videoId) {
    try {
      // Force ANDROID client for the fetch
      const info = await this.yt.getBasicInfo(videoId, 'ANDROID');
      const format = info.chooseFormat({ type: 'video+audio', quality: 'best' });

      // If it's a direct URL, return it; otherwise, attempt one last decipher
      return format.url || await format.decipher(this.yt.session.player);
    } catch (err) {
      console.error(`[Remix] Failed to fetch stream for ${videoId}:`, err.message);
      return null;
    }
  }
}