import { CommandBuilder } from "../src/CommandHandler.mjs";
import Player from "../src/Player.mjs";

export function joinChannel(message, cid, cb = () => {}, ecb = () => {}) {
  if (!this.client.channels.cache.has(cid)) {
    ecb();
    return message.replyEmbed("Couldn't find the channel `" + cid + "`\nUse the help command to learn more about this. (`%help join`)");
  }
  if (this.playerMap.has(cid)) {
    cb(this.playerMap.get(cid));
    return message.replyEmbed("Already joined <#" + cid + ">.");
  }
  const settings = this.getSettings(message);
  const p = new Player(this.config.token, {
    client: this.client,
    spotify: this.spotifyConfig,
    settings,
    spotifyClient: this.spotify,
    geniusClient: this.geniusClient,
    messageChannel: message.channel,
    ytdlp: this.ytdlp,
    innertube: this.innertube
  });
  p.on("autoleave", async () => {
    message.channel.sendEmbed("Left channel <#" + cid + "> because of inactivity.");
    this.playerMap.delete(cid);
    p.destroy();
  });
  p.on("message", m => {
    if (this.getSettings(message).get("songAnnouncements") === "false") return;
    message.channel.sendEmbed(m);
  });
  this.playerMap.set(cid, p);
  message.replyEmbed("Joining Channel...").then(m => {
    p.join(cid).then(() => {
      m.editEmbed(`✅ Successfully joined <#${cid}>`);
      cb(p);
    });
  });
}

export const command = new CommandBuilder()
  .setName("join")
  .setDescription("Make the bot join a specific voice channel.", "commands.join")
  .setId("join")
  .addChannelOption(option =>
    option.setName("Channel ID")
      .setType("voiceChannel")
      .setId("cid")
      .setDescription("Specify the channel the bot should join. It will try to find you automatically if not provided.", "options.join.channel-deprecated")
      .setDynamicDefault((_client, message) => {
        if (!message) return null;
        const guild = message.message?.guild;
        if (!guild) return null;
        const voiceState = guild.voiceStates?.cache?.get(message.author?.id);
        return voiceState?.channelId ?? null;
      })
      .setRequired(true)
  );

export function run(message, data) {
  const cid = data.getById("cid").value || this.players.checkVoiceChannels(message);
  this.players.initPlayer(message, cid);
}

export const exportDef = {
  name: "joinChannel",
  object: joinChannel
};
