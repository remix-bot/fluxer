import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("playnext")
  .setId("playnext")
  .setDescription("Same as %play. The result will be added to the top of the queue.", "commands.playnext")
  .addTextOption(option =>
    option.setName("query")
      .setDescription("A YouTube query/url, playlist url, or a link to a Spotify, SoundCloud, or YouTube Music song.", "options.playnext.query")
      .setRequired(true)
  )
  .addChoiceOption(o =>
    o.setName("provider")
      .setDescription("The search result provider (YouTube, YouTube Music or SoundCloud). Default: YouTube Music", "options.search.provider")
      .addFlagAliases("p", "u", "use")
      .addChoices("ytm", "yt", "scld")
      .setDefault("ytm")
  , true)
  .addAlias("pn");

export async function run(message, data) {
  const p = await this.getPlayer(message);
  if (!p) return;
  const query = data.get("query").value;
  message.replyEmbed("Searching...").then(msg => {
    const messages = p.playFirst(query, data.get("provider").value);
    messages.on("message", d => { msg.editEmbed(d, message); });
  });
}
