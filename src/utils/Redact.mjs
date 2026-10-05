/**
 * @module src/utils/Redact
 * @description Value-based secret redaction. The eval command used to redact only by property
 * NAME on objects, so `this.config.token` (a plain string) came back in clear. These helpers
 * collect the actual secret values from the config and mask them wherever they appear in text.
 *
 * This is a safety net against ACCIDENTAL leaks (dumping `this.client` into a channel), not a
 * security boundary: anyone who can run eval can transform a secret before printing it.
 */

const SECRET_KEY = /token|secret|passw(or)?d|api_?key|authorization|credential|webhook|sessdata|cookie|session_?key|private_?key|key$/i;
const URL_WITH_CREDS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^@\s]+@/i;

/**
 * Collect secret-looking string values from a config-like object.
 * @param {*} root - Usually the bot's config object.
 * @param {{minLength?: number, maxDepth?: number}} [opts]
 * @returns {string[]} Distinct secret values, longest first (so partial overlaps mask fully).
 */
export function collectSecrets(root, { minLength = 6, maxDepth = 8 } = {}) {
  const found = new Set();
  const seen = new WeakSet();
  const walk = (node, depth) => {
    if (depth > maxDepth || node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") {
        if (value.length >= minLength && (SECRET_KEY.test(key) || URL_WITH_CREDS.test(value))) found.add(value);
      } else if (value && typeof value === "object") {
        walk(value, depth + 1);
      }
    }
  };
  walk(root, 0);
  return [...found].sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of every secret in `text`.
 * @param {string} text
 * @param {string[]} secrets
 * @param {string} [mask="[REDACTED]"]
 * @returns {string}
 */
export function redactSecrets(text, secrets, mask = "[REDACTED]") {
  let out = String(text);
  for (const s of secrets ?? []) if (s) out = out.split(s).join(mask);
  return out;
}

export default { collectSecrets, redactSecrets };
