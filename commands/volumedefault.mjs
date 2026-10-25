/**
 * @module commands/volumedefault
 * @description View or set the server default volume. Requires Manage Server permission to set.
 */

import { CommandBuilder } from "../src/commands/index.mjs";
import { EmbedBuilder } from "@fluxerjs/core";
import { getGlobalColor } from "../src/ui/index.mjs";
import { PermissionFlags } from "@fluxerjs/core";
import { MAX_VOLUME } from "../src/utils/UI.mjs";

/**
 * @private
 * Build an ASCII slider bar for volume display.
 * @param {number} volume
 * @param {number} max
 * @returns {string}
 */
function buildVolumeSlider(volume, max = MAX_VOLUME) {
  const totalSlots = 14;
  const filled = Math.min(totalSlots, Math.max(0, Math.round((volume / max) * totalSlots)));
  let bar = "";
  for (let i = 0; i < totalSlots; i++) {
    bar += i < filled ? "■" : "─";
  }
  return `\`0%\` \`[${bar}]\` \`${max}%\` • **${volume}%**`;
}

/** @type {CommandBuilder} @description Command definition for the volumedefault command. */
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

/**
 * @async
 * Run handler for the volumedefault command.
 * Displays or persists the server's default volume setting.
 * @param {object} message - The command message wrapper.
 * @param {object} data - Parsed command data containing the optional volume option.
 * @returns {Promise<void>}
 */
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
        const pfx = this.handler.getPrefix(message.channel?.guildId ?? message.message?.guildId);
        embed
            .setAuthor({ name: this.t(message, "responses.volumedefault.author") })
            .setTitle(this.t(message, "responses.volumedefault.title"))
            .setDescription(
                hasManage
                    ? this.t(message, "responses.volumedefault.changeHint", { prefix: pfx, max: MAX_VOLUME })
                    : this.t(message, "responses.volumedefault.noPermission")
            )
            .addFields(
                { name: this.t(message, "responses.volumedefault.fieldDefault"), value: buildVolumeSlider(currentDefault), inline: false },
                { name: this.t(message, "responses.volumedefault.fieldActive"), value: `${currentPlayerVol}%`, inline: true }
            );
    } else if (!hasManage) {
        embed.setDescription(this.t(message, "responses.volumedefault.noPermissionSet"));
    } else {
        const pct = Number(raw);
        if (pct < 0 || pct > MAX_VOLUME) {
            embed.setDescription(this.t(message, "responses.volumedefault.outOfRange", { max: MAX_VOLUME }));
        } else {
            p.setVolume(pct / 100);
            if (set) set.set("volume", pct);
            embed
                .setAuthor({ name: this.t(message, "responses.volumedefault.authorSaved") })
                .setDescription(this.t(message, "responses.volumedefault.saved", { volume: pct }))
                .addFields({ name: this.t(message, "responses.volumedefault.fieldNewDefault"), value: buildVolumeSlider(pct), inline: false });
        }
    }

    message.reply({ embeds: [embed] }).catch(() => {});
}
