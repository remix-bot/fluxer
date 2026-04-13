import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

const NUMBER_EMOJIS = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];
const CANCEL_EMOJI  = "❌";
const PREV_EMOJI    = "⬅️";
const NEXT_EMOJI    = "➡️";

function mkEmbed(desc, title) {
  const b = new EmbedBuilder().setColor(getGlobalColor()).setDescription(desc);
  if (title) b.setTitle(title);
  return { embeds: [b.toJSON()] };
}

export const command = function() {
  if (!this.config.radio?.length) return null;
  return new CommandBuilder()
      .setName("radio")
      .setDescription("Play a radio station. Use `%radio list` to browse all stations.", "commands.radio")
      .addAliases("r")
      .setCategory("music")
      .addTextOption(o =>
          o.setName("station")
              .setDescription("Station name, 'list' to browse, or leave blank for default.")
              .setRequired(false)
      );
};

export async function run(msg, data) {
  const radios = this.config.radio;
  if (!radios?.length) return msg.replyEmbed(mkEmbed("❌ No radio stations are configured."));

  const input = (data.get("station")?.value ?? "").trim().toLowerCase();

  if (input === "list") {
    let page = 0;
    const perPage = NUMBER_EMOJIS.length;
    const totalPages = Math.ceil(radios.length / perPage);

    const buildPage = () => {
      const start    = page * perPage;
      const pickable = radios.slice(start, start + perPage);

      let desc = `📻 **Radio Stations (Page ${page + 1}/${totalPages})**\n\n`;
      pickable.forEach((r, i) => {
        desc += `${NUMBER_EMOJIS[i]} **${r.detailedName}** (\`${r.name}\`)\n`;
        desc += `   ${r.description.replaceAll("\n", "\n   ")}\n\n`;
      });
      desc += `━━━━━━━━━━━━━━━━━━━━━━\n`;
      desc += `${PREV_EMOJI} Previous   ${NEXT_EMOJI} Next   ${CANCEL_EMOJI} Cancel`;

      return { payload: mkEmbed(desc), pickable };
    };

    let { payload, pickable } = buildPage();
    const listMsg = await msg.replyEmbed(payload);
    if (!listMsg) return;

    const baseEmojis = [...NUMBER_EMOJIS, PREV_EMOJI, NEXT_EMOJI, CANCEL_EMOJI];
    for (const e of baseEmojis) await listMsg.message.react(e).catch(() => {});

    let settled = false;

    const clearReactions = async () => {
      const rawMsg = listMsg.message;
      try {
        await rawMsg.removeAllReactions();
      } catch (_) {
        for (const emoji of baseEmojis) {
          try { await rawMsg.removeReaction(emoji); } catch (_) {}
        }
      }
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      unobserve();
      clearReactions().catch(() => {});
      listMsg.editEmbed(mkEmbed("📻 Radio selection timed out.")).catch(() => {});
    }, 60_000);

    const normalize = (s) => s.replace(/\uFE0F/g, "");

    const unobserve = listMsg.onReaction(baseEmojis, async (e) => {
      if (settled) return;
      const emoji = normalize(e.emoji_id);

      if (emoji === normalize(CANCEL_EMOJI)) {
        settled = true;
        clearTimeout(timeout);
        unobserve();
        await clearReactions();
        listMsg.editEmbed(mkEmbed("❌ Radio selection cancelled.")).catch(() => {});
        return;
      }
      if (emoji === normalize(NEXT_EMOJI)) page = (page + 1) % totalPages;
      else if (emoji === normalize(PREV_EMOJI)) page = (page - 1 + totalPages) % totalPages;
      else {
        const idx = NUMBER_EMOJIS.findIndex(x => normalize(x) === emoji);
        if (idx !== -1 && idx < pickable.length) {
          settled = true;
          clearTimeout(timeout);
          unobserve();
          await clearReactions();
          const selected = radios[page * perPage + idx];
          return playStation(this, msg, selected, listMsg);
        }
      }

      const next = buildPage();
      pickable = next.pickable;
      await listMsg.editEmbed(next.payload).catch(() => {});
    }, msg.author);

    return;
  }

  if (input) {
    const radio = radios.find(r => r.name.toLowerCase() === input);
    if (!radio) {
      const names = radios.map(r => `\`${r.name}\``).join(", ");
      return msg.replyEmbed(mkEmbed(`❌ Unknown station \`${input}\`. Available: ${names}\n\nUse \`%radio list\` to browse.`));
    }
    return playStation(this, msg, radio);
  }

  return playStation(this, msg, radios[0]);
}

async function playStation(ctx, msg, radio, editTarget = null) {
  const p = await ctx.getPlayer(msg, true, true, true);
  if (!p) return;

  const current = p.queue.getCurrent();
  const hasRadioQueued = p.queue.data.some(t => t.type === "radio");
  if (current?.type === "radio" || hasRadioQueued) await p.switchRadio(radio);
  else p.playRadio(radio);

  const embed = new EmbedBuilder()
    .setColor(getGlobalColor())
    .setTitle(`📻 ${radio.detailedName}`)
    .setDescription(
      `**[${radio.detailedName}](${radio.author.url})**\n\n` +
      `${radio.description}\n\n` +
      `_Use \`%skip\` to stop the radio, or \`%radio list\` to switch stations._`
    )
    .toJSON();

  if (editTarget) editTarget.editEmbed({ embeds: [embed] }).catch(() => {});
  else msg.replyEmbed({ embeds: [embed] }).catch(() => {});
}
