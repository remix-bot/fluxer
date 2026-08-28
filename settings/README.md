# Settings System

Per-guild settings for Remix, backed by MySQL.

## How it works

- Defaults live in `storage/defaults.json`. Every guild starts from this template.
- `src/Settings.mjs` contains the implementation:
  - `SettingsManager` — defines the setting keys, their defaults and descriptions.
  - `ServerSettings` — per-guild view; `get`/`set`/`reset` operate in memory and persist with an 80 ms debounced write.
  - `RemoteSettingsManager` — loads every guild row from the MySQL `settings` table (`id` primary key + `data` JSON column) and writes individual keys back with `JSON_SET`.
- The `settings` table is the only table you need to create manually:

  ```sql
  CREATE TABLE `settings` (
    `id` varchar(70) NOT NULL,
    `data` json NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
  ```

## Files

| File | Purpose |
| :--- | :--- |
| `Settings.mjs` | Re-export of `src/Settings.mjs` classes |
| `migrate.mjs` | One-shot tool that clones every guild row from one settings table/bot ID to another (`npm run migrate`) |
| `runnables.mjs` | Validators applied when a setting changes (e.g. `prefix` must be ≤ 5 chars with no whitespace, `pfp` only accepts `default`) |

## Managing settings in a server

Use the `%settings` command (requires Manage Server):

- `%settings get` — view all settings for this server
- `%settings set <key> <value>` — change a setting
- `%settings reset <key>` — reset a setting to its default
- `%settings help` — explain a specific key

Shortcut commands `prefix` / `pfx` and `247` map to the corresponding settings keys.
