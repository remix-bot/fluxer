/**
 * providers.mjs — Single source of truth for all provider data.
 *
 * PROVIDERS      — full map: { prefix, label } — used by worker.mjs for search
 * PROVIDER_NAMES — derived label-only map      — used by Player.mjs for display
 * PROVIDER_CHOICES — ordered list of valid keys — used by command option builders
 *
 * Edit only here; worker.mjs and Player.mjs import from this file.
 */

export const PROVIDERS = {
  // ── Standard search ──────────────────────────────────────────────────────
  yt:        { prefix: "ytsearch",    label: "YouTube" },
  ytm:       { prefix: "ytmsearch",   label: "YouTube Music" },
  scld:      { prefix: "scsearch",    label: "SoundCloud" },
  sc:        { prefix: "scsearch",    label: "SoundCloud" },
  sp:        { prefix: "spsearch",    label: "Spotify" },
  spotify:   { prefix: "spsearch",    label: "Spotify" },
  am:        { prefix: "amsearch",    label: "Apple Music" },
  apple:     { prefix: "amsearch",    label: "Apple Music" },
  dz:        { prefix: "dzsearch",    label: "Deezer" },
  deezer:    { prefix: "dzsearch",    label: "Deezer" },
  td:        { prefix: "tdsearch",    label: "Tidal" },
  tidal:     { prefix: "tdsearch",    label: "Tidal" },
  bc:        { prefix: "bcsearch",    label: "Bandcamp" },
  bandcamp:  { prefix: "bcsearch",    label: "Bandcamp" },
  adm:       { prefix: "admsearch",   label: "Audiomack" },
  audiomack: { prefix: "admsearch",   label: "Audiomack" },
  gaana:     { prefix: "gaanasearch", label: "Gaana" },
  js:        { prefix: "jssearch",    label: "JioSaavn" },
  jiosaavn:  { prefix: "jssearch",    label: "JioSaavn" },
  lf:        { prefix: "lfsearch",    label: "Last.fm" },
  lastfm:    { prefix: "lfsearch",    label: "Last.fm" },
  pd:        { prefix: "pdsearch",    label: "Pandora" },
  pandora:   { prefix: "pdsearch",    label: "Pandora" },
  vk:        { prefix: "vksearch",    label: "VK Music" },
  mc:        { prefix: "mcsearch",    label: "Mixcloud" },
  mixcloud:  { prefix: "mcsearch",    label: "Mixcloud" },
  nc:        { prefix: "ncsearch",    label: "NicoVideo" },
  nicovideo: { prefix: "ncsearch",    label: "NicoVideo" },
  bb:        { prefix: "bilibili",    label: "Bilibili" },
  bilibili:  { prefix: "bilibili",    label: "Bilibili" },
  sh:        { prefix: "shsearch",    label: "Shazam" },
  shazam:    { prefix: "shsearch",    label: "Shazam" },
  sl:        { prefix: "slsearch",    label: "Songlink" },
  songlink:  { prefix: "slsearch",    label: "Songlink" },
  qb:        { prefix: "qbsearch",    label: "Qobuz" },
  qobuz:     { prefix: "qbsearch",    label: "Qobuz" },
  ym:        { prefix: "ymsearch",    label: "Yandex Music" },
  yandex:    { prefix: "ymsearch",    label: "Yandex Music" },
  au:        { prefix: "ausearch",    label: "Audius" },
  audius:    { prefix: "ausearch",    label: "Audius" },
  az:        { prefix: "azsearch",    label: "Amazon Music" },
  amazon:    { prefix: "azsearch",    label: "Amazon Music" },
  ag:        { prefix: "agsearch",    label: "Anghami" },
  anghami:   { prefix: "agsearch",    label: "Anghami" },
  bk:        { prefix: "bksearch",    label: "Bluesky" },
  bluesky:   { prefix: "bksearch",    label: "Bluesky" },
  // ── Recommendations ──────────────────────────────────────────────────────
  ytrec:     { prefix: "ytrec",       label: "YouTube (recommended)" },
  sprec:     { prefix: "sprec",       label: "Spotify (recommended)" },
  dzrec:     { prefix: "dzrec",       label: "Deezer (recommended)" },
  tdrec:     { prefix: "tdrec",       label: "Tidal (recommended)" },
  jsrec:     { prefix: "jsrec",       label: "JioSaavn (recommended)" },
  vkrec:     { prefix: "vkrec",       label: "VK Music (recommended)" },
  // ── TTS ──────────────────────────────────────────────────────────────────
  gtts:      { prefix: "gtts",        label: "Google TTS" },
  tts:       { prefix: "gtts",        label: "Google TTS" },
  ftts:      { prefix: "ftts",        label: "Flowery TTS" },
};

/** Label-only map — convenience alias for display use (e.g. Player.mjs). */
export const PROVIDER_NAMES = Object.fromEntries(
  Object.entries(PROVIDERS).map(([k, v]) => [k, v.label])
);

export const PROVIDER_CHOICES = [
  "ytm", "yt", "scld", "sc",
  "sp", "spotify",
  "am", "apple",
  "dz", "deezer",
  "td", "tidal",
  "bc", "bandcamp",
  "adm", "audiomack",
  "gaana",
  "js", "jiosaavn",
  "lf", "lastfm",
  "pd", "pandora",
  "vk",
  "mc", "mixcloud",
  "nc", "nicovideo",
  "bb", "bilibili",
  "sh", "shazam",
  "sl", "songlink",
  "qb", "qobuz",
  "ym", "yandex",
  "au", "audius",
  "az", "amazon",
  "ag", "anghami",
  "bk", "bluesky",
  "ytrec", "sprec", "dzrec", "tdrec", "jsrec", "vkrec",
  "gtts", "tts", "ftts",
];
