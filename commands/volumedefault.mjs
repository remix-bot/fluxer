import { CommandBuilder } from "../src/CommandHandler.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/MessageHandler.mjs";
import { PermissionFlags } from "@fluxerjs/core";

const MAX_VOLUME = 200;

export const command = new CommandBuilder()
    .setName("volumedefault")
    .setDescription("View or set the server default volume. (Requires Manage Server to set)", "commands.volumedefault")
    .setCategory("music")
    .addNumberOption(o =>
        o.setName("volume")
            .setDescription(`New volume in % (0–${MAX_VOLUME}) to save as server default. Leave empty to view current.`)
            .setRequired(false)
    )
    .addAliases("vd");

export async function run(message, data) {
    const p = await this.getPlayer(message, false, false, false);
    if (!p) return;

    const set      = this.getSettings(message);
    const authorId = message.message?.author?.id;
    const guild    = message.message?.guild ?? null;
    const member   = guild?.members?.get(authorId) ?? message.message?.member ?? null;
    const isOwner  = (this.handler?.owners ?? []).includes(authorId);

    const hasManage = isOwner
        || member?.permissions?.has(PermissionFlags["Administrator"])
        || member?.permissions?.has(PermissionFlags["ManageGuild"]);

    const volOption = data.get("volume");
    const raw       = volOption?.value;

    const embed = new EmbedBuilder().setColor(getGlobalColor());

    if (!volOption || raw === null || raw === undefined || isNaN(Number(raw))) {
        const currentDefault   = set?.get("volume") ?? 100;
        const currentPlayerVol = Math.round((p.preferredVolume ?? 1) * 100);
        embed
            .setTitle("🔊 Volume Settings")
            .setDescription(
                `• Server default: \`${currentDefault}%\`\n` +
                `• Current player volume: \`${currentPlayerVol}%\`\n\n` +
                (hasManage
                    ? `To change the default, use: \`${set?.get("prefix") ?? "%"}volumedefault <0-${MAX_VOLUME}>\``
                    : `⚠️ You need **Manage Server** permission to change the default.`)
            );
    } else if (!hasManage) {
        embed.setDescription("❌ You need **Manage Server** permission to set the server default volume.");
    } else {
        const pct = Number(raw);
        if (pct < 0 || pct > MAX_VOLUME) {
            embed.setDescription(`❌ Volume must be between \`0\` and \`${MAX_VOLUME}%\`.`);
        } else {
            p.setVolume(pct / 100);
            if (set) set.set("volume", pct);
            embed.setDescription(`🔊 Server default volume saved as \`${pct}%\`.`);
        }
    }

    message.replyEmbed({ embeds: [embed.toJSON()] });
}
