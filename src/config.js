const SERVICE_KEY = "__jumangCompletionSoundService";
const HANDLERS_KEY = "__jumangCompletionSoundHandlers";
const START_MP3_SOUND = "codex_not_start.mp3";
const START_MP3_FILE = "assets/codex_not_start.mp3";
const FINISH_MP3_SOUND = "codex_not_finish.mp3";
const FINISH_MP3_FILE = "assets/codex_not_finish.mp3";
const POP_AIFF_SOUND = "codex_not_pop.aiff";
const POP_AIFF_FILE = "assets/codex_not_pop.aiff";
const POP2_MP3_SOUND = "codex_not_pop2.mp3";
const POP2_MP3_FILE = "assets/codex_not_pop2.mp3";
const POP3_MP3_SOUND = "codex_not_pop3.mp3";
const POP3_MP3_FILE = "assets/codex_not_pop3.mp3";
const POP4_MP3_SOUND = "codex_not_pop4.mp3";
const POP4_MP3_FILE = "assets/codex_not_pop4.mp3";
const POP5_MP3_SOUND = "codex_not_pop5.mp3";
const POP5_MP3_FILE = "assets/codex_not_pop5.mp3";
const POP6_MP3_SOUND = "codex_not_pop6.mp3";
const POP6_MP3_FILE = "assets/codex_not_pop6.mp3";
const POP7_MP3_SOUND = "codex_not_pop7.mp3";
const POP7_MP3_FILE = "assets/codex_not_pop7.mp3";
const RANDOM_POP_SOUND = "Random pop";
const LEGACY_MP3_SOUND = "codex_not.mp3";
const LEGACY_MP3_FILE = "assets/codex_not.mp3";
const POP_SOUND_CHOICES = [
  POP_AIFF_SOUND,
  POP2_MP3_SOUND,
  POP3_MP3_SOUND,
  POP4_MP3_SOUND,
  POP5_MP3_SOUND,
  POP6_MP3_SOUND,
  POP7_MP3_SOUND,
];
const ACTIVITY_SOUND_KEYS = [
  "reasoning",
  "message",
  "function_call",
  "function_call_output",
  "tool_call",
  "custom_tool_call",
  "custom_tool_call_output",
  "local_shell_call",
  "web_search_call",
  "computer_call",
  "response_item",
];
const DEFAULT_ACTIVITY_SOUNDS = {
  reasoning: POP6_MP3_SOUND,
  message: POP_AIFF_SOUND,
  function_call: POP3_MP3_SOUND,
  function_call_output: POP4_MP3_SOUND,
  tool_call: POP_AIFF_SOUND,
  custom_tool_call: POP2_MP3_SOUND,
  custom_tool_call_output: POP4_MP3_SOUND,
  local_shell_call: POP6_MP3_SOUND,
  web_search_call: POP5_MP3_SOUND,
  computer_call: RANDOM_POP_SOUND,
  response_item: POP2_MP3_SOUND,
};

const DEFAULT_CONFIG = {
  enabled: true,
  monitorSessions: true,
  rendererFallback: true,
  startSound: START_MP3_SOUND,
  finishSound: START_MP3_SOUND,
  activitySound: POP2_MP3_SOUND,
  activitySounds: DEFAULT_ACTIVITY_SOUNDS,
  volume: 0.5,
  cooldownMs: 1000,
  activityCooldownMs: 50,
  minBusyMs: 900,
  wideChatEnabled: true,
  chatMaxWidthRem: 88,
  randomPopDefaultsMigrated: true,
  fixedPopDefaultsMigrated: true,
};

const MAC_SOUNDS = {
  [START_MP3_SOUND]: START_MP3_FILE,
  [FINISH_MP3_SOUND]: FINISH_MP3_FILE,
  [RANDOM_POP_SOUND]: RANDOM_POP_SOUND,
  [POP_AIFF_SOUND]: POP_AIFF_FILE,
  [POP2_MP3_SOUND]: POP2_MP3_FILE,
  [POP3_MP3_SOUND]: POP3_MP3_FILE,
  [POP4_MP3_SOUND]: POP4_MP3_FILE,
  [POP5_MP3_SOUND]: POP5_MP3_FILE,
  [POP6_MP3_SOUND]: POP6_MP3_FILE,
  [POP7_MP3_SOUND]: POP7_MP3_FILE,
  [LEGACY_MP3_SOUND]: LEGACY_MP3_FILE,
  Glass: "/System/Library/Sounds/Glass.aiff",
  Ping: "/System/Library/Sounds/Ping.aiff",
  Pop: "/System/Library/Sounds/Pop.aiff",
  Tink: "/System/Library/Sounds/Tink.aiff",
  Hero: "/System/Library/Sounds/Hero.aiff",
};

function normalizeConfig(value) {
  const source = isPlainObject(value) ? value : {};
  const next = { ...DEFAULT_CONFIG, ...source };
  next.enabled = next.enabled !== false;
  next.monitorSessions = next.monitorSessions !== false;
  next.rendererFallback = next.rendererFallback !== false;
  next.wideChatEnabled = next.wideChatEnabled !== false;
  next.startSound = isKnownSound(next.startSound) ? next.startSound : DEFAULT_CONFIG.startSound;
  next.activitySound = isKnownSound(next.activitySound) ? next.activitySound : DEFAULT_CONFIG.activitySound;
  next.activitySounds = normalizeActivitySounds(next.activitySounds, next.activitySound);
  if (source.randomPopDefaultsMigrated !== true) {
    next.activitySound = isOldDefaultPopSound(next.activitySound) ? RANDOM_POP_SOUND : next.activitySound;
    next.activitySounds = migrateOldDefaultPopSounds(next.activitySounds);
    next.randomPopDefaultsMigrated = true;
  }
  if (source.fixedPopDefaultsMigrated !== true) {
    next.activitySound = DEFAULT_CONFIG.activitySound;
    next.activitySounds = { ...DEFAULT_ACTIVITY_SOUNDS };
    next.fixedPopDefaultsMigrated = true;
  }
  next.finishSound = isKnownSound(next.finishSound) ? next.finishSound : DEFAULT_CONFIG.finishSound;
  next.sound = next.finishSound;
  next.volume = clampNumber(next.volume, 0, 1);
  next.cooldownMs = clampNumber(next.cooldownMs, 0, 60000);
  next.activityCooldownMs = clampNumber(next.activityCooldownMs, 0, 60000);
  next.minBusyMs = clampNumber(next.minBusyMs, 0, 30000);
  next.chatMaxWidthRem = clampNumber(next.chatMaxWidthRem, 32, 96);
  return next;
}

function isKnownSound(sound) {
  return Object.prototype.hasOwnProperty.call(MAC_SOUNDS, sound);
}

function normalizeActivitySounds(value, fallback) {
  const source = isPlainObject(value) ? value : {};
  const out = {};
  for (const key of ACTIVITY_SOUND_KEYS) {
    const sound = source[key];
    out[key] = isKnownSound(sound)
      ? sound
      : isKnownSound(DEFAULT_ACTIVITY_SOUNDS[key])
        ? DEFAULT_ACTIVITY_SOUNDS[key]
        : fallback;
  }
  return out;
}

function migrateOldDefaultPopSounds(activitySounds) {
  const out = { ...activitySounds };
  for (const key of ACTIVITY_SOUND_KEYS) {
    if (isOldDefaultPopSound(out[key])) out[key] = RANDOM_POP_SOUND;
  }
  return out;
}

function isOldDefaultPopSound(sound) {
  return sound === POP_AIFF_SOUND || sound === "codex_not_pop.mp3";
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function compactText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

module.exports = {
  SERVICE_KEY,
  HANDLERS_KEY,
  START_MP3_SOUND,
  FINISH_MP3_SOUND,
  POP_AIFF_SOUND,
  POP2_MP3_SOUND,
  POP3_MP3_SOUND,
  POP4_MP3_SOUND,
  POP5_MP3_SOUND,
  POP6_MP3_SOUND,
  POP7_MP3_SOUND,
  RANDOM_POP_SOUND,
  LEGACY_MP3_SOUND,
  POP_SOUND_CHOICES,
  ACTIVITY_SOUND_KEYS,
  DEFAULT_ACTIVITY_SOUNDS,
  DEFAULT_CONFIG,
  MAC_SOUNDS,
  normalizeConfig,
  isKnownSound,
  isPlainObject,
  clampNumber,
  compactText,
};
