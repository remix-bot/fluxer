/**
 * @module commands/lastfm
 * @description Last.fm integration command supporting account linking, scrobbling,
 * profile viewing, leaderboards, whoknows, and playlist playback. The action
 * implementations live in commands/lastfm/ (one module per action family);
 * run() below dispatches to them via their action sets.
 */


import { CommandBuilder } from "../src/commands/index.mjs";
import {
  ACCOUNT_ACTIONS, runAccountActions,
  PLAYBACK_ACTIONS, runPlaybackActions,
  LISTENING_ACTIONS, runListeningActions,
  WHOKNOWS_ACTIONS, runWhoknowsActions,
  INFO_ACTIONS, runInfoActions,
  TAG_ACTIONS, runTagActions,
  DISCOVERY_ACTIONS, runDiscoveryActions,
  runLastFmHelp,
  notConfigured,
} from "./lastfm/index.mjs";

export { playLastFmCategory } from "./lastfm/playback.mjs";

/**
 * @type {CommandBuilder}
 * @description Command definition for the lastfm command.
 */
export const command = new CommandBuilder()
  .setName("lastfm")
  .setDescription("Link your Last.fm account, toggle scrobbling, or view your profile.", "commands.lastfm")
  .setCategory("util")
  .addAliases("lf", "lfm")
  .addChoiceOption(o =>
    o.setName("action")
      .setDescription("The action to perform: link, unlink, np, profile, loved, top, recent, playlists, play, scrobble, leaderboard, whoknows, artistinfo, albuminfo, trackinfo, topalbums, toptags, tag, compare, cover, refreshmembers, affinity, crowns, whoknowstrack, whoknowsalbum, artisttags, albumtags, tracktags, friends, weekly, trending, geo, tagalbums, artisttracks, search", "options.lastfm.action")
      .addChoices(
        "link", "confirm", "unlink", "np", "profile", "loved", "top", "recent",
        "playlists", "play", "scrobble", "leaderboard", "lb", "love", "unlove",
        "artists", "whoknows", "wk", "artistinfo", "ai", "albuminfo", "ali",
        "trackinfo", "ti", "topalbums", "toptags", "tags", "tag", "compare",
        "fmc", "cover", "art", "refreshmembers", "rm", "affinity", "af",
        "crowns", "cr", "whoknowstrack", "wkt", "whoknowsalbum", "wka",
        "artisttags", "at", "albumtags", "alt", "tracktags", "tt",
        "friends", "fr", "weekly", "wc", "trending", "tr",
        "geo", "g", "tagalbums", "ta", "artisttracks", "atr",
        "search", "s"
      )
      .setRequired(false)
  )
  .addUserOption(o =>
    o.setName("user")
      .setDescription("Another user (for compare/profile). Use: -user @mention or -u @mention")
      .setRequired(false)
      .addFlagAliases("u"),
    true
  )
  .addTextOption(o =>
    o.setName("token")
      .setDescription("The auth token from Last.fm (used with 'confirm' action), or a search query / period")
      .setRequired(false)
  );

/**
 * Run handler for the lastfm command.
 * Routes to the appropriate subcommand based on the action option.
 *
 * @param {object} msg - The command message wrapper.
 * @param {object} data - Parsed command data containing action, user, and token options.
 * @returns {Promise<void>}
 */

export async function run(msg, data) {
  const lastfm = this.lastfm;
  if (!lastfm || !lastfm.enabled) return msg.reply(notConfigured(this, msg));

  const prefix = this.handler.getPrefix(msg.message?.guildId);
  const action = data.get("action")?.value ?? "profile";
  const userId = msg.message?.author?.id ?? msg.author?.id;
  const targetUserId = data.get("user")?.value ?? null;

  if (ACCOUNT_ACTIONS.has(action))
    return runAccountActions.call(this, msg, data, lastfm, prefix, userId, targetUserId, action);
  if (PLAYBACK_ACTIONS.has(action))
    return runPlaybackActions.call(this, msg, data, lastfm, prefix, userId, targetUserId, action);
  if (LISTENING_ACTIONS.has(action))
    return runListeningActions.call(this, msg, data, lastfm, prefix, userId, targetUserId, action);
  if (WHOKNOWS_ACTIONS.has(action))
    return runWhoknowsActions.call(this, msg, data, lastfm, prefix, userId, targetUserId, action);
  if (INFO_ACTIONS.has(action))
    return runInfoActions.call(this, msg, data, lastfm, prefix, userId, targetUserId, action);
  if (TAG_ACTIONS.has(action))
    return runTagActions.call(this, msg, data, lastfm, prefix, userId, targetUserId, action);
  if (DISCOVERY_ACTIONS.has(action))
    return runDiscoveryActions.call(this, msg, data, lastfm, prefix, userId, targetUserId, action);
  return runLastFmHelp.call(this, msg, data, lastfm, prefix, userId, targetUserId, action);
}
