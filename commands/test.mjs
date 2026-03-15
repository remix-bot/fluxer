import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("test")
  .setDescription("A test command used for various purposes.")
  .setRequirement(r => r.setOwnerOnly(true))
  .addUserOption(o =>
    o.setName("user")
      .setDescription("A user")
      .addFlagAliases("u")
      .setDefault("0")
      .setId("testOption")
  , true)
  .addStringOption(o =>
    o.setName("test")
      .setDescription("test string")
      .setRequired(true)
  )
  .addTextOption(o =>
    o.setName("string")
      .setDescription("A cool string")
      .setRequired(true));

export async function run(msg, data) {
  msg.replyEmbed(
    "Ref String: " + data.get("string").value +
    "; " + data.get("test").value +
    "; Option received: " + data.getById("testOption")?.value
  );
}
