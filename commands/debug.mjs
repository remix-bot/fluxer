import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

export const command = new CommandBuilder()
  .setName("debug")
  .setDescription("A debug command for various purposes.")
  .setRequirement(r => r.setOwnerOnly(true))
  .setCategory("util")
  .addChoiceOption(o =>
    o.setName("target")
      .setDescription("The target that should be examined.")
      .addChoices("voice")
      .setRequired(true));

export function run(msg, data) {
  switch (data.get("target").value) {
    case "voice": {
      const servers = [...this.players.playerMap.entries()].map(([cid, s]) => {
        const channel = this.client.channels.get(cid);
        const conn = s.connection;
        const room = conn?.room;
        const roomState = room?.state ?? "no-room";
        const hasMediaPlayer = !!s._mediaPlayer && !s._mediaPlayer?.destroyed;
        return {
          name:      channel?.name ?? "unknown",
          id:        channel?.id ?? cid,
          channelId: s._channelId ?? cid,
          guildId:   s._guildId ?? "unknown",
          guildname: channel?.guild?.name ?? "unknown",
          conn:      conn ? "yes" : "null",
          roomState,
          mediaPlayer: hasMediaPlayer ? "alive" : (s._mediaPlayer?.destroyed ? "destroyed" : "none"),
          destroyed: s._destroyed ?? false,
          leaving:   s.leaving ?? false,
          joining:   s._isJoining ?? false,
          recovering: s._isRecovering ?? false,
          paused:    s._paused ?? false,
          hasQueue:  !!(s.queue?.getCurrent() || !s.queue?.isEmpty()),
          home247:   s._home247Channel ?? null,
        };
      });
      const pending = [...(this.players._pendingJoins ?? [])];
      const summary = {
        playerMapSize: this.players.playerMap.size,
        livePlayers: servers.filter(s => s.conn === "yes" && !s.destroyed && !s.leaving).length,
        pendingJoins: pending.length,
        pendingChannels: pending,
      };
      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle(this.t(msg, "responses.debug.voiceTitle"))
        .setDescription("```json\n" + JSON.stringify({ summary, servers }, null, 2) + "\n```")
        ;
      msg.reply({ embeds: [embed] });
      break;
    }
  }
}
