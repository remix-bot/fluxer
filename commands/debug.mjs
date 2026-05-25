import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";

const EMOJI_REMOVE_TIMEOUT = 60_000;

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

export async function run(msg, data) {
  switch (data.get("target").value) {
    case "voice": {
      const servers = [...this.players.playerMap.entries()].map(([cid, s]) => {
        const channel = this.client.channels.get(cid);
        const guildId = s._guildId ?? channel?.guildId ?? channel?.guild_id;
        const guild   = guildId ? this.client.guilds.get(String(guildId).replace(/\D/g, "")) : null;
        const conn = s.connection;
        const room = conn?.room;
        const roomState = room?.connectionState ?? (room?.isConnected ? "connected" : "disconnected");
        const hasMediaPlayer = !!s._mediaPlayer && !s._mediaPlayer?.destroyed;
        return {
          name:      channel?.name ?? "unknown",
          id:        channel?.id ?? cid,
          channelId: s._channelId ?? cid,
          guildId:   guildId ?? "unknown",
          guildname: guild?.name ?? channel?.guild?.name ?? "unknown",
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

      const MAX_DESC = 4096;
      const CODE_WRAP = 12;

      const pages = [];

      const summaryLines = [
        `📊 **Summary**`,
        `Players in map: **${summary.playerMapSize}**`,
        `Live players:   **${summary.livePlayers}**`,
        `Pending joins:  **${summary.pendingJoins}**${summary.pendingChannels.length ? ` (\`${summary.pendingChannels.join("`, `")}\`)` : ""}`,
        ``,
        `**Players:**`,
      ];
      for (let i = 0; i < servers.length; i++) {
        const s = servers[i];
        const status = s.conn === "yes" && !s.destroyed && !s.leaving ? "🟢" : "🔴";
        const line = `${status} \`${s.guildname}\` / \`#${s.name}\` — conn:${s.conn} room:${s.roomState} media:${s.mediaPlayer}`;
        if (summaryLines.join("\n").length + line.length + 1 > MAX_DESC - 30) {
          summaryLines.push(`… and ${servers.length - i} more (see next pages)`);
          break;
        }
        summaryLines.push(line);
      }
      pages.push(summaryLines.join("\n"));

      {
        let groupJson = "";

        let i = 0;
        for (i = 0; i < servers.length; i++) {
          const singleJson = JSON.stringify(servers[i], null, 2);
          const candidate = groupJson
            ? groupJson.slice(0, -1) + ",\n" + singleJson.slice(1)
            : singleJson;

          if (("```json\n" + candidate + "\n```").length > MAX_DESC && groupJson) {
            pages.push(("```json\n" + groupJson + "\n```").slice(0, MAX_DESC));
            groupJson = singleJson;
          } else if (("```json\n" + candidate + "\n```").length > MAX_DESC) {
            const budget = MAX_DESC - CODE_WRAP;
            groupJson = singleJson.slice(0, budget);
            pages.push(("```json\n" + groupJson + "\n```").slice(0, MAX_DESC));
            groupJson = "";
          } else {
            groupJson = candidate;
          }
        }
        if (groupJson) {
          pages.push(("```json\n" + groupJson + "\n```").slice(0, MAX_DESC));
        }
      }

      if (pages.length === 1) {
        const embed = new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(this.t(msg, "responses.debug.voiceTitle"))
          .setDescription(pages[0].slice(0, MAX_DESC))
          ;
        return msg.reply({ embeds: [embed] });
      }

      const totalPages = pages.length;
      let currentPage = 0;

      const buildPage = (pageIdx, expired = false) => {
        const pageLabel = pageIdx === 0
          ? "Summary"
          : `Player Detail${pages[pageIdx].includes(",") ? "s" : ""}`;
        const footerText = expired
          ? this.t(msg, "responses._common.controlsExpired")
          : `${this.t(msg, "responses.eval.pageLabel", { page: pageIdx + 1, total: totalPages })} • ${this.t(msg, "responses.eval.navigateHint")}`;

        const embed = new EmbedBuilder()
          .setColor(getGlobalColor())
          .setTitle(this.t(msg, "responses.debug.voiceTitle") + ` — ${pageLabel}`)
          .setDescription(pages[pageIdx].slice(0, MAX_DESC))
          .setFooter({ text: footerText })
          ;
        return { embeds: [embed] };
      };

      const replyMsg = await msg.reply(buildPage(0));
      if (!replyMsg?.message) return;

      const navEmojis = ["⬅️", "➡️", "❌"];
      for (const emoji of navEmojis) {
        await replyMsg.message.react(emoji).catch(() => {});
      }

      const clearReactions = async () => {
        try {
          await replyMsg.message.removeAllReactions();
        } catch {
          for (const emoji of navEmojis) {
            try { await replyMsg.message.removeReaction(emoji); } catch {}
          }
        }
      };

      let emojiTimeout;
      const resetTimer = () => {
        clearTimeout(emojiTimeout);
        emojiTimeout = setTimeout(async () => {
          unobserve?.();
          await clearReactions();
          await replyMsg.edit(buildPage(currentPage, true)).catch(() => {});
        }, EMOJI_REMOVE_TIMEOUT);
      };

      const unobserve = replyMsg.onReaction(navEmojis, async (e) => {
        if (e.emoji_id === "❌") {
          clearTimeout(emojiTimeout);
          unobserve?.();
          await replyMsg.message.delete().catch(() => {});
          return;
        }

        resetTimer();

        if (e.emoji_id === "⬅️") {
          currentPage = currentPage > 0 ? currentPage - 1 : totalPages - 1;
        } else if (e.emoji_id === "➡️") {
          currentPage = currentPage < totalPages - 1 ? currentPage + 1 : 0;
        }

        await replyMsg.edit(buildPage(currentPage)).catch(() => {});
      });

      resetTimer();
      break;
    }
  }
}
