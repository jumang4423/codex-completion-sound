const {
  ACTIVITY_SOUND_KEYS,
  DEFAULT_CONFIG,
  POP_AIFF_SOUND,
  POP_SOUND_CHOICES,
  isKnownSound,
} = require('./config');

function randomPopSound() {
  return POP_SOUND_CHOICES[Math.floor(Math.random() * POP_SOUND_CHOICES.length)] || POP_AIFF_SOUND;
}

function completionTimeMs(row, payload) {
  if (typeof payload.completed_at === "number" && Number.isFinite(payload.completed_at)) {
    return payload.completed_at * 1000;
  }
  return eventTimeMs(row);
}

function eventTimeMs(row) {
  const parsed = Date.parse(row.timestamp || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function isAssistantActivityPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  const type = typeof payload.type === "string" ? payload.type : "";
  const role = typeof payload.role === "string" ? payload.role : "";
  if (role === "user" || role === "system") return false;
  if (type === "message") return !role || role === "assistant";
  return /^(function_call|function_call_output|reasoning|tool_call|web_search_call|computer_call|local_shell_call)$/.test(type) ||
    /(assistant|response|output|call|tool|reason|move)/i.test(type);
}

function normalizeActivityType(type) {
  const raw = typeof type === "string" ? type : "";
  const normalized = raw.trim().replace(/[-/ .]+/g, "_").toLowerCase();
  if (ACTIVITY_SOUND_KEYS.includes(normalized)) return normalized;
  if (normalized.includes("reason")) return "reasoning";
  if (normalized.includes("message")) return "message";
  if (normalized.includes("function_call_output")) return "function_call_output";
  if (normalized.includes("function_call")) return "function_call";
  if (normalized.includes("custom_tool_call_output")) return "custom_tool_call_output";
  if (normalized.includes("custom_tool_call")) return "custom_tool_call";
  if (normalized.includes("local_shell")) return "local_shell_call";
  if (normalized.includes("web_search")) return "web_search_call";
  if (normalized.includes("computer")) return "computer_call";
  if (normalized.includes("tool")) return "tool_call";
  return "response_item";
}

function activitySoundFor(config, activityType) {
  const key = normalizeActivityType(activityType);
  const sound = config.activitySounds?.[key];
  if (isKnownSound(sound)) return sound;
  return isKnownSound(config.activitySound) ? config.activitySound : DEFAULT_CONFIG.activitySound;
}

function activityKey(row, payload) {
  return [
    row.timestamp || "",
    payload.type || "",
    payload.role || "",
    payload.phase || "",
    payload.id || payload.call_id || payload.item_id || "",
    activityFingerprint(payload),
  ].join("\n");
}

function activityFingerprint(payload) {
  const content = payload.content;
  if (typeof content === "string") return content.slice(0, 160);
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item || typeof item !== "object") return "";
      return String(item.text || item.input || item.output || item.type || "");
    }).join("|").slice(0, 160);
  }
  return String(payload.name || payload.status || payload.summary || "").slice(0, 160);
}

module.exports = {
  randomPopSound,
  completionTimeMs,
  eventTimeMs,
  isAssistantActivityPayload,
  normalizeActivityType,
  activitySoundFor,
  activityKey,
};
