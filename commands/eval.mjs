import { CommandBuilder } from "../src/CommandHandler.mjs";
import { inspect } from "node:util";

async function runEval(expression) {
  const clean = async (text) => {
    if (text && text.constructor?.name === "Promise") text = await text;
    const restricted = ["token", "config", "key", "clientSecret", "clientId"];
    const removeSensitive = (obj, level = 0) => {
      if (level === 2 || typeof obj !== "object" || obj === null) return obj;
      let copied = false;
      level++;
      for (const key in obj) {
        if (restricted.includes(key)) {
          if (!copied) { obj = { ...obj }; copied = true; }
          obj[key] = null;
        }
        if (typeof obj[key] === "object") obj[key] = removeSensitive(obj[key], level);
      }
      return obj;
    };
    const containsSensitive = (obj, level = 0) => {
      if (level === 2 || typeof obj !== "object" || obj === null) return false;
      level++;
      for (const key in obj) {
        if (restricted.includes(key)) return true;
        if (typeof obj[key] === "object" && containsSensitive(obj[key], level)) return true;
      }
      return false;
    };
    if (typeof text === "object") text = removeSensitive(containsSensitive(text) ? { ...text } : text);
    if (typeof text !== "string") text = inspect(text, { depth: 1 });
    text = text.replace(/`/g, "`" + String.fromCharCode(8203)).replace(/@/g, "@" + String.fromCharCode(8203));
    return text;
  };

  try {
    const evalued = eval("'use strict';" + expression);
    const cleaned = await clean(evalued);
    return ("Expression returned: \n```js\n" + cleaned).slice(0, 1900) + "\n```";
  } catch (e) {
    return ("Expression returned an error: \n```js\n" + (await clean(e))).slice(0, 1900) + "\n```";
  }
}

export const command = new CommandBuilder()
  .setName("eval")
  .setDescription("eval() function; dev only")
  .addRequirement(r => r.setOwnerOnly(true))
  .addTextOption(o =>
    o.setName("expression")
      .setDescription("The expression to execute")
      .setRequired(true)
  );

export async function run(msg, data) {
  const expression = data.get("expression").value;
  msg.reply(await runEval.call(Object.assign({ message: msg }, this), expression));
}
