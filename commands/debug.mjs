import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("debug")
  .setDescription("A debug command for various purposes.")
  .setRequirement(r => r.setOwnerOnly(true))  // ← fixed
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
          name: channel?.name ?? "unknown",
          id: channel?.id ?? cid,
          status: s.connection?.state?.status ?? "unknown",
          guildname: channel?.guild?.name ?? "unknown",
          guildid: channel?.guildId ?? "unknown"
        };
      });
      msg.replyEmbed("```json\n" + JSON.stringify(servers, null, 2) + "\n```");
      break;
    }
  }
}