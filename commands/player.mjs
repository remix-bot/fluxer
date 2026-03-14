import { CommandBuilder } from "../src/CommandHandler.mjs";

export const command = new CommandBuilder()
  .setName("player")
  .setDescription("Create an emoji player control for your voice channel", "commands.player");

export async function run(msg) {
  const p = await this.getPlayer(msg);
  if (!p) return;

  const Timeout = this.config.playerAFKTimeout || 10 * 6000;
  const controls = ["▶️", "⏸️", "⏭️", "🔁", "🔀"];
  const form = "Currently Playing: $current\n\n$lastMsg";
  let lastContent = form
    .replace(/\$current/gi, p.getCurrent())
    .replace(/\$lastMsg/gi, "Control updates will appear here");

  msg.replyEmbed(lastContent).then(async m => {
    for (const emoji of controls) {
      try { await m.message.react(emoji); } catch (_) {}
    }

    let suspensionTimeout = setTimeout(() => close(), Timeout);
    let lastUpdate = "Control updates will appear here";

    const update = (s = lastUpdate) => {
      lastContent = form
        .replace(/\$current/gi, p.getCurrent())
        .replace(/\$lastMsg/gi, s);
      m.editEmbed(lastContent);
      lastUpdate = s;
    };

    const close = () => {
      unobserve();
      m.editEmbed({
        embedText: lastContent + "\n\nSession Closed. The player controls **won't respond** from here.",
        content: "Player Session Closed"
      });
    };

    p.on("message", () => update());

    const unobserve = m.onReaction(controls, e => {
      let reply = "";
      switch (e.emoji_id) {
        case controls[0]: reply = p.resume() || "Successfully Resumed"; break;
        case controls[1]: reply = p.pause() || "Successfully Paused"; break;
        case controls[2]: reply = p.skip() || "Successfully Skipped"; break;
        case controls[3]: reply = p.loop("queue"); break;
        case controls[4]: reply = p.shuffle() || "Successfully shuffled"; break;
      }
      clearTimeout(suspensionTimeout);
      suspensionTimeout = setTimeout(() => close(), Timeout);
      update(reply);
    });
  });
}
