import { CommandBuilder } from "../src/CommandHandler.mjs";
import { execFile } from "node:child_process";
import YTDlpWrapModule from "yt-dlp-wrap-extended";
const YTDlpWrap = YTDlpWrapModule.default ?? YTDlpWrapModule;

export const command = new CommandBuilder()
  .setName("update")
  .setDescription("Update the youtube-dlp binaries", "commands.update")
  .addAliases("uy", "u")
  .setRequirement(r => r.setOwnerOnly(true));

export async function run(message) {
  if (!this.ytdlp || typeof this.ytdlp.binaryPath !== "string") {
    message.replyEmbed("ytdlp not set or binary path not typeof string");
    return;
  }
  await message.replyEmbed("Spawning yt-dlp update process...");
  execFile(this.ytdlp.binaryPath, ["-U"], (err, stdout, stderr) => {
    if (err) {
      message.replyEmbed("yt-dlp update check failed: `" + err.message + "`");
      console.warn("[Command: update] yt-dlp update check failed:", err.message);
      return;
    }
    this.ytdlp = new YTDlpWrap(this.ytdlp.binaryPath);
    const out = (stdout || stderr || "up to date").split("\n")[0];
    console.log("[Command: update] yt-dlp update:", out);
    message.replyEmbed("yt-dlp update output: `" + out + "`");
  });
}
