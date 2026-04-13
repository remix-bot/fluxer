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
        const channel = this.client.channels.cache.get(cid);
        return {
          name:      channel?.name ?? "unknown",
          id:        channel?.id ?? cid,
          status:    s.connection?.state?.status ?? "unknown",
          guildname: channel?.guild?.name ?? "unknown",
          guildid:   channel?.guildId ?? "unknown"
        };
      });
      const embed = new EmbedBuilder()
        .setColor(getGlobalColor())
        .setTitle("🔧 Voice Debug")
        .setDescription("```json\n" + JSON.stringify(servers, null, 2) + "\n```")
        .toJSON();
      msg.replyEmbed({ embeds: [embed] });
      break;
    }
  }
}
