/**
 * Completion Sound
 *
 * Plays short native sounds when a Codex task starts, emits activity, and completes.
 *
 * Primary detection runs in the main process by tailing Codex session JSONL
 * files for `user_message`, assistant activity, and `task_complete` events.
 * Renderer-side UI and message detection is a fallback for app builds that stop
 * writing those events.
 */

const SERVICE_KEY = "__jumangCompletionSoundService";
const HANDLERS_KEY = "__jumangCompletionSoundHandlers";
const START_MP3_SOUND = "codex_not_start.mp3";
const START_MP3_FILE = "assets/codex_not_start.mp3";
const FINISH_MP3_SOUND = "codex_not_finish.mp3";
const FINISH_MP3_FILE = "assets/codex_not_finish.mp3";
const POP_AIFF_SOUND = "codex_not_pop.aiff";
const POP_AIFF_FILE = "assets/codex_not_pop.aiff";
const POP_MP3_SOUND = "codex_not_pop.mp3";
const POP_MP3_FILE = "assets/codex_not_pop.mp3";
const LEGACY_MP3_SOUND = "codex_not.mp3";
const LEGACY_MP3_FILE = "assets/codex_not.mp3";

const DEFAULT_CONFIG = {
  enabled: true,
  monitorSessions: true,
  rendererFallback: true,
  startSound: START_MP3_SOUND,
  finishSound: FINISH_MP3_SOUND,
  activitySound: POP_AIFF_SOUND,
  volume: 0.45,
  cooldownMs: 2500,
  activityCooldownMs: 350,
  minBusyMs: 900,
  wideChatEnabled: true,
  chatMaxWidthRem: 64,
};

const MAC_SOUNDS = {
  [START_MP3_SOUND]: START_MP3_FILE,
  [FINISH_MP3_SOUND]: FINISH_MP3_FILE,
  [POP_AIFF_SOUND]: POP_AIFF_FILE,
  [POP_MP3_SOUND]: POP_MP3_FILE,
  [LEGACY_MP3_SOUND]: LEGACY_MP3_FILE,
  Glass: "/System/Library/Sounds/Glass.aiff",
  Ping: "/System/Library/Sounds/Ping.aiff",
  Pop: "/System/Library/Sounds/Pop.aiff",
  Tink: "/System/Library/Sounds/Tink.aiff",
  Hero: "/System/Library/Sounds/Hero.aiff",
};

/** @type {import("@codex-plusplus/sdk").Tweak} */
module.exports = {
  async start(api) {
    if (api.process === "main") {
      startMain.call(this, api);
      return;
    }
    await startRenderer.call(this, api);
  },

  stop() {
    const state = this._state;
    if (!state) return;
    if (state.process === "renderer") stopRenderer(state);
    if (state.process === "main") stopMain(state);
    this._state = null;
  },
};

// ------------------------------------------------------------------ main --

function startMain(api) {
  const service = createMainService(api);
  globalThis[SERVICE_KEY]?.dispose?.();
  globalThis[SERVICE_KEY] = service;

  if (!globalThis[HANDLERS_KEY]) {
    api.ipc.handle("get-config", () => {
      return globalThis[SERVICE_KEY]?.getConfig?.() || DEFAULT_CONFIG;
    });
    api.ipc.handle("set-config", (patch) => {
      return globalThis[SERVICE_KEY]?.setConfig?.(patch) || DEFAULT_CONFIG;
    });
    api.ipc.handle("play", (opts = {}) => {
      return globalThis[SERVICE_KEY]?.play?.(opts) || { played: false };
    });
    api.ipc.handle("status", () => {
      return globalThis[SERVICE_KEY]?.status?.() || null;
    });
    globalThis[HANDLERS_KEY] = true;
  }

  service.start();
  this._state = { process: "main", service };
}

function stopMain(state) {
  if (globalThis[SERVICE_KEY] === state.service) {
    state.service.dispose();
    globalThis[SERVICE_KEY] = null;
  }
}

function createMainService(api) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const childProcess = require("node:child_process");

  const startedAtMs = Date.now();
  const home = process.env.HOME || os.homedir();
  const roots = [
    path.join(home, ".codex", "sessions"),
    path.join(home, ".codex", "archived_sessions"),
  ];
  const positions = new Map();
  const pending = new Map();
  const seenTurns = new Set();
  const seenUserMessages = new Set();
  const seenActivity = new Set();
  let timer = null;
  let disposed = false;
  let lastStartPlayedAt = 0;
  let lastActivityPlayedAt = 0;
  let lastFinishPlayedAt = 0;
  let lastTask = null;
  let lastScanAt = 0;

  const readConfig = () => normalizeConfig(api.storage.get("config", DEFAULT_CONFIG));
  const writeConfig = (patch) => {
    const next = normalizeConfig({ ...readConfig(), ...(isPlainObject(patch) ? patch : {}) });
    api.storage.set("config", next);
    return next;
  };

  const service = {
    start() {
      initializeOffsets();
      timer = setInterval(scan, 500);
      timer.unref?.();
      api.log.info("completion sound monitor active");
    },

    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      positions.clear();
      pending.clear();
    },

    getConfig() {
      return readConfig();
    },

    setConfig(patch) {
      return writeConfig(patch);
    },

    status() {
      return {
        lastTask,
        lastPlayedAt: Math.max(lastStartPlayedAt, lastActivityPlayedAt, lastFinishPlayedAt),
        lastStartPlayedAt,
        lastActivityPlayedAt,
        lastFinishPlayedAt,
        lastScanAt,
        watchedFiles: positions.size,
        roots,
      };
    },

    play(opts = {}) {
      if (opts.event === "activity") return playActivity(opts);
      return opts.event === "start" ? playStart(opts) : playCompletion(opts);
    },
  };

  return service;

  function initializeOffsets() {
    for (const file of collectJsonlFiles()) {
      try {
        positions.set(file, fs.statSync(file).size);
      } catch {
        // Ignore files that disappear during startup.
      }
    }
  }

  function scan() {
    if (disposed) return;
    const config = readConfig();
    lastScanAt = Date.now();

    for (const file of collectJsonlFiles()) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }

      let pos = positions.get(file);
      if (pos == null) {
        pos = stat.mtimeMs >= startedAtMs - 5000 ? 0 : stat.size;
      }
      if (stat.size < pos) pos = 0;
      if (stat.size === pos) {
        positions.set(file, pos);
        continue;
      }

      let chunk;
      try {
        const buf = fs.readFileSync(file);
        chunk = buf.slice(pos, stat.size).toString("utf8");
      } catch (error) {
        api.log.warn("failed to read session delta", file, error);
        continue;
      }
      positions.set(file, stat.size);

      const combined = (pending.get(file) || "") + chunk;
      const lines = combined.split("\n");
      let carry = "";
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line) continue;
        const ok = handleSessionLine(line, config);
        if (!ok && i === lines.length - 1) carry = line;
      }
      if (carry) pending.set(file, carry);
      else pending.delete(file);
    }
  }

  function handleSessionLine(line, config) {
    if (
      !line.includes('"type":"task_complete"') &&
      !line.includes('"type":"user_message"') &&
      !line.includes('"type":"response_item"')
    ) return true;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return false;
    }
    const payload = row && row.payload;
    if (!payload) return true;
    if (row.type === "response_item") return handleResponseItem(row, payload, config);
    if (payload.type === "user_message") return handleUserMessage(row, payload, config);
    if (payload.type !== "task_complete") return true;

    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
    if (turnId && seenTurns.has(turnId)) return true;
    if (turnId) seenTurns.add(turnId);

    const completedAtMs = completionTimeMs(row, payload);
    if (completedAtMs && completedAtMs < startedAtMs - 3000) return true;

    lastTask = {
      at: Date.now(),
      completedAtMs,
      source: "session-jsonl",
      turnId,
    };

    if (config.monitorSessions !== false) {
      playCompletion({ source: "session-jsonl", turnId, force: false });
    }
    return true;
  }

  function handleResponseItem(row, payload, config) {
    if (!isAssistantActivityPayload(payload)) return true;

    const emittedAtMs = eventTimeMs(row);
    if (emittedAtMs && emittedAtMs < startedAtMs - 3000) return true;

    const key = activityKey(row, payload);
    if (seenActivity.has(key)) return true;
    seenActivity.add(key);

    lastTask = {
      at: Date.now(),
      activityAtMs: emittedAtMs,
      source: "session-jsonl",
      event: "assistant-activity",
      itemType: payload.type || null,
      phase: payload.phase || null,
    };

    if (config.monitorSessions !== false) {
      playActivity({ source: `session-${payload.type || "response-item"}`, force: false });
    }
    return true;
  }

  function handleUserMessage(row, payload, config) {
    const message = typeof payload.message === "string" ? payload.message : "";
    const key = [
      row.timestamp || "",
      message.slice(0, 120),
      String(message.length),
    ].join("\n");
    if (seenUserMessages.has(key)) return true;
    seenUserMessages.add(key);

    const sentAtMs = eventTimeMs(row);
    if (sentAtMs && sentAtMs < startedAtMs - 3000) return true;

    lastTask = {
      at: Date.now(),
      startedAtMs: sentAtMs,
      source: "session-jsonl",
      event: "user-message",
    };

    if (config.monitorSessions !== false) {
      playStart({ source: "session-jsonl", force: false });
    }
    return true;
  }

  function playStart(opts = {}) {
    return playConfiguredSound("start", opts);
  }

  function playActivity(opts = {}) {
    return playConfiguredSound("activity", opts);
  }

  function playCompletion(opts = {}) {
    return playConfiguredSound("finish", opts);
  }

  function playConfiguredSound(kind, opts = {}) {
    const config = readConfig();
    if (config.enabled === false && !opts.force) return { played: false, reason: "disabled" };

    const now = Date.now();
    const cooldown = kind === "activity"
      ? clampNumber(config.activityCooldownMs, 0, 60000)
      : clampNumber(config.cooldownMs, 0, 60000);
    const lastPlayedAt = kind === "start"
      ? lastStartPlayedAt
      : kind === "activity"
        ? lastActivityPlayedAt
        : lastFinishPlayedAt;
    if (!opts.force && now - lastPlayedAt < cooldown) {
      return { played: false, reason: "cooldown" };
    }
    if (kind === "start") lastStartPlayedAt = now;
    else if (kind === "activity") lastActivityPlayedAt = now;
    else lastFinishPlayedAt = now;

    const volume = clampNumber(config.volume, 0, 1);
    const sound = kind === "start"
      ? config.startSound
      : kind === "activity"
        ? config.activitySound
        : config.finishSound;
    const result = playNativeSound(sound, volume);
    const label = kind === "start" ? "start sound" : kind === "activity" ? "activity sound" : "completion sound";
    api.log.info(label, {
      source: opts.source || "manual",
      sound,
      played: result.played,
      reason: result.reason || null,
    });
    return result;
  }

  function playNativeSound(soundName, volume) {
    try {
      if (process.platform === "darwin") {
        const configuredFile = MAC_SOUNDS[soundName] || MAC_SOUNDS[DEFAULT_CONFIG.finishSound] || MAC_SOUNDS.Glass;
        const file = path.isAbsolute(configuredFile)
          ? configuredFile
          : path.join(__dirname, configuredFile);
        if (!fs.existsSync(file)) return { played: false, reason: "sound-file-missing" };
        const child = childProcess.spawn(
          "/usr/bin/afplay",
          ["-v", String(volume), file],
          { detached: true, stdio: "ignore" },
        );
        child.unref?.();
        return { played: true, method: "afplay" };
      }

      if (process.platform === "win32") {
        const child = childProcess.spawn(
          "powershell.exe",
          ["-NoProfile", "-Command", "[console]::beep(880,140); [console]::beep(1175,120)"],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        child.unref?.();
        return { played: true, method: "powershell-beep" };
      }

      for (const cmd of [
        ["paplay", ["/usr/share/sounds/freedesktop/stereo/complete.oga"]],
        ["canberra-gtk-play", ["-i", "complete"]],
      ]) {
        const child = childProcess.spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref?.();
        return { played: true, method: cmd[0] };
      }
    } catch (error) {
      api.log.warn("native sound failed", error);
      return { played: false, reason: String(error && error.message ? error.message : error) };
    }
    return { played: false, reason: "unsupported-platform" };
  }

  function collectJsonlFiles() {
    const out = [];
    for (const root of roots) collect(root, out);
    return out;
  }

  function collect(dir, out) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full, out);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  }
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

// --------------------------------------------------------------- renderer --

async function startRenderer(api) {
  const state = {
    process: "renderer",
    api,
    config: await getConfig(api),
    pageHandle: null,
    layoutStyleEl: null,
    observer: null,
    messageHandler: null,
    clickHandler: null,
    keyHandler: null,
    busy: false,
    busyStartedAt: 0,
    lastSignal: null,
    statusEl: null,
    checkTimer: null,
    audioContext: null,
  };
  this._state = state;

  installLayoutTweaks(state);
  installRendererDetectors(state);
  installSettingsPage(state);
}

function stopRenderer(state) {
  state.pageHandle?.unregister?.();
  state.pageHandle = null;
  state.layoutStyleEl?.remove?.();
  state.layoutStyleEl = null;
  state.observer?.disconnect?.();
  state.observer = null;
  if (state.messageHandler) window.removeEventListener("message", state.messageHandler, true);
  state.messageHandler = null;
  if (state.clickHandler) document.removeEventListener("click", state.clickHandler, true);
  state.clickHandler = null;
  if (state.keyHandler) document.removeEventListener("keydown", state.keyHandler, true);
  state.keyHandler = null;
  if (state.checkTimer) clearTimeout(state.checkTimer);
  state.checkTimer = null;
}

async function getConfig(api) {
  try {
    return normalizeConfig(await api.ipc.invoke("get-config"));
  } catch (error) {
    api.log.warn("get-config failed", error);
    return { ...DEFAULT_CONFIG };
  }
}

async function patchConfig(state, patch) {
  try {
    state.config = normalizeConfig(await state.api.ipc.invoke("set-config", patch));
  } catch (error) {
    state.api.log.warn("set-config failed", error);
    state.config = normalizeConfig({ ...state.config, ...patch });
  }
  updateLayoutTweaks(state);
  updateStatus(state);
  return state.config;
}

function installLayoutTweaks(state) {
  const style = document.createElement("style");
  style.id = "codex-completion-sound-layout";
  document.head.appendChild(style);
  state.layoutStyleEl = style;
  updateLayoutTweaks(state);
}

function updateLayoutTweaks(state) {
  if (!state.layoutStyleEl) return;
  if (state.config.wideChatEnabled === false) {
    state.layoutStyleEl.textContent = "";
    return;
  }
  const width = clampNumber(state.config.chatMaxWidthRem, 32, 96);
  state.layoutStyleEl.textContent = `
    [data-codex-window-type="electron"] body {
      --thread-content-max-width: ${width}rem !important;
    }
  `;
}

function installRendererDetectors(state) {
  state.messageHandler = (event) => {
    if (state.config.rendererFallback === false) return;
    const startSignal = findStartSignal(event.data);
    if (startSignal) signalStart(state, startSignal);
    const activitySignal = findActivitySignal(event.data);
    if (activitySignal) signalActivity(state, activitySignal);
    const signal = findCompletionSignal(event.data);
    if (signal) signalCompletion(state, signal);
  };
  window.addEventListener("message", state.messageHandler, true);

  state.clickHandler = (event) => {
    if (state.config.rendererFallback === false) return;
    if (isSendButtonEvent(event)) signalStart(state, { source: "renderer-send-click" });
  };
  document.addEventListener("click", state.clickHandler, true);

  state.keyHandler = (event) => {
    if (state.config.rendererFallback === false) return;
    if (isSendKeyEvent(event)) signalStart(state, { source: "renderer-send-key" });
  };
  document.addEventListener("keydown", state.keyHandler, true);

  const schedule = () => scheduleBusyCheck(state);
  state.observer = new MutationObserver(schedule);
  state.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-label", "aria-busy", "data-state", "disabled", "title"],
  });
  schedule();
}

function scheduleBusyCheck(state) {
  if (state.checkTimer) return;
  state.checkTimer = setTimeout(() => {
    state.checkTimer = null;
    checkBusyState(state);
  }, 150);
}

function checkBusyState(state) {
  if (state.config.rendererFallback === false) return;
  const busy = detectBusyUi();
  const now = Date.now();

  if (busy && !state.busy) {
    state.busy = true;
    state.busyStartedAt = now;
    setLastSignal(state, "running", "renderer-dom");
    return;
  }

  if (!busy && state.busy) {
    const elapsed = now - state.busyStartedAt;
    state.busy = false;
    state.busyStartedAt = 0;
    if (elapsed >= clampNumber(state.config.minBusyMs, 0, 30000)) {
      signalCompletion(state, { source: "renderer-dom" });
    }
  }
}

function detectBusyUi() {
  const controls = document.querySelectorAll("button,[role='button'],[aria-label],[title]");
  for (const el of controls) {
    if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
    const text = compactText([
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.textContent,
    ].filter(Boolean).join(" "));
    if (/\b(stop|interrupt)\b/i.test(text)) return true;
    if (/(stop|cancel)\s+(generating|generation|response|task|turn)/i.test(text)) return true;
  }

  const statuses = document.querySelectorAll(
    "[role='status'],[aria-live],[aria-busy='true'],[data-testid*='status' i]",
  );
  for (const el of statuses) {
    if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
    const text = compactText(el.textContent || "");
    if (/\b(thinking|reasoning|working|running|generating|executing)\b/i.test(text)) {
      return true;
    }
  }
  return false;
}

function isSendButtonEvent(event) {
  const target = event.target instanceof Element ? event.target : null;
  const buttonEl = target?.closest?.("button,[role='button']");
  return isSendControl(buttonEl);
}

function isSendKeyEvent(event) {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey) return false;
  const active = document.activeElement;
  if (!isComposerInput(active)) return false;
  return isLikelyComposerInput(active) || !!findSendControlNear(active);
}

function isComposerInput(el) {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") {
    const type = String(el.getAttribute("type") || "text").toLowerCase();
    return ["", "text", "search"].includes(type);
  }
  return el.isContentEditable || el.getAttribute("role") === "textbox";
}

function isLikelyComposerInput(el) {
  if (!(el instanceof HTMLElement)) return false;
  const text = compactText([
    el.getAttribute("aria-label"),
    el.getAttribute("placeholder"),
    el.getAttribute("data-testid"),
  ].filter(Boolean).join(" "));
  return /\b(composer|prompt|message|chat|ask)\b/i.test(text) || /(プロンプト|メッセージ|質問|入力)/.test(text);
}

function findSendControlNear(el) {
  const root = el instanceof HTMLElement ? el.closest("form,[data-testid*='composer' i],[class*='composer' i]") : null;
  const controls = (root || document).querySelectorAll("button,[role='button']");
  for (const el of controls) {
    if (isSendControl(el)) return el;
  }
  return null;
}

function isSendControl(el) {
  if (!(el instanceof HTMLElement) || !isVisible(el)) return false;
  if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
  const text = compactText([
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.getAttribute("data-testid"),
    el.textContent,
  ].filter(Boolean).join(" "));
  if (!text || /\b(stop|interrupt|cancel)\b/i.test(text)) return false;
  return /\b(send|submit|run)\b/i.test(text) || /(送信|実行)/.test(text);
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0;
}

function findStartSignal(value) {
  const seen = new Set();
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    const v = item.value;
    if (!v || typeof v !== "object" || seen.has(v) || item.depth > 5) continue;
    seen.add(v);

    const type = typeof v.type === "string" ? v.type : "";
    const method = typeof v.method === "string" ? v.method : "";
    if (
      type === "user_message" ||
      type === "turn/submitted" ||
      type === "turn/started" ||
      type === "prompt/submitted" ||
      method === "turn/submitted" ||
      method === "turn/started" ||
      method === "prompt/submitted"
    ) {
      return { source: `message-${type || method}` };
    }

    for (const key of ["payload", "params", "event", "notification", "message", "data"]) {
      if (v[key] && typeof v[key] === "object") {
        stack.push({ value: v[key], depth: item.depth + 1 });
      }
    }
  }
  return null;
}

function findActivitySignal(value) {
  const seen = new Set();
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    const v = item.value;
    if (!v || typeof v !== "object" || seen.has(v) || item.depth > 5) continue;
    seen.add(v);

    const type = typeof v.type === "string" ? v.type : "";
    const method = typeof v.method === "string" ? v.method : "";
    const payload = v.payload || v.item || v.output_item || v.response_item || v.message;
    if ((type === "response_item" || /output[_/-]?item/i.test(type) || /response[_/-]?item/i.test(type)) && isAssistantActivityPayload(payload)) {
      return { source: `message-${type || "response-item"}` };
    }
    if (/response[./_-]?(output|content|item)[./_-]?(added|done|delta)/i.test(type || method)) {
      return { source: `message-${type || method}` };
    }

    for (const key of ["payload", "params", "event", "notification", "message", "data", "item", "output_item"]) {
      if (v[key] && typeof v[key] === "object") {
        stack.push({ value: v[key], depth: item.depth + 1 });
      }
    }
  }
  return null;
}

function findCompletionSignal(value) {
  const seen = new Set();
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    const v = item.value;
    if (!v || typeof v !== "object" || seen.has(v) || item.depth > 5) continue;
    seen.add(v);

    const type = typeof v.type === "string" ? v.type : "";
    const method = typeof v.method === "string" ? v.method : "";
    if (type === "turn/completed" || method === "turn/completed") {
      const status = v.turn?.status || v.params?.turn?.status || v.payload?.turn?.status;
      if (!status || status === "completed") {
        return { source: "message-turn-completed" };
      }
    }
    if (type === "task_complete") return { source: "message-task-complete" };

    for (const key of ["payload", "params", "event", "notification", "message", "data"]) {
      if (v[key] && typeof v[key] === "object") {
        stack.push({ value: v[key], depth: item.depth + 1 });
      }
    }
  }
  return null;
}

async function signalStart(state, signal) {
  if (state.config.enabled === false) return;
  setLastSignal(state, "started", signal.source || "renderer");
  try {
    const result = await state.api.ipc.invoke("play", {
      event: "start",
      source: signal.source || "renderer",
    });
    if (shouldUseRendererFallback(result)) {
      playWebAudioFallback(state, "start");
    }
  } catch (error) {
    state.api.log.warn("main start sound invoke failed; using renderer fallback", error);
    playWebAudioFallback(state, "start");
  }
}

async function signalActivity(state, signal) {
  if (state.config.enabled === false) return;
  setLastSignal(state, "activity", signal.source || "renderer");
  try {
    const result = await state.api.ipc.invoke("play", {
      event: "activity",
      source: signal.source || "renderer",
    });
    if (shouldUseRendererFallback(result)) {
      playWebAudioFallback(state, "activity");
    }
  } catch (error) {
    state.api.log.warn("main activity sound invoke failed; using renderer fallback", error);
    playWebAudioFallback(state, "activity");
  }
}

async function signalCompletion(state, signal) {
  if (state.config.enabled === false) return;
  if (state.config.monitorSessions !== false && signal.source === "renderer-dom") return;
  setLastSignal(state, "completed", signal.source || "renderer");
  try {
    const result = await state.api.ipc.invoke("play", {
      event: "finish",
      source: signal.source || "renderer",
    });
    if (shouldUseRendererFallback(result)) {
      playWebAudioFallback(state, "finish");
    }
  } catch (error) {
    state.api.log.warn("main sound invoke failed; using renderer fallback", error);
    playWebAudioFallback(state, "finish");
  }
}

function shouldUseRendererFallback(result) {
  if (!result) return true;
  if (result.played !== false) return false;
  return result.reason !== "cooldown" && result.reason !== "disabled";
}

function playWebAudioFallback(state, kind = "finish") {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = state.audioContext || new Ctx();
    state.audioContext = ctx;
    ctx.resume?.();

    const now = ctx.currentTime;
    const volume = clampNumber(state.config.volume, 0, 1) * 0.16;
    if (kind === "start") {
      beep(ctx, now, 660, 0.08, volume);
      beep(ctx, now + 0.09, 880, 0.1, volume);
    } else if (kind === "activity") {
      beep(ctx, now, 990, 0.055, volume);
    } else {
      beep(ctx, now, 880, 0.09, volume);
      beep(ctx, now + 0.11, 1175, 0.12, volume);
    }
  } catch (error) {
    state.api.log.warn("web audio fallback failed", error);
  }
}

function beep(ctx, start, frequency, duration, volume) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function setLastSignal(state, kind, source) {
  state.lastSignal = { kind, source, at: Date.now() };
  updateStatus(state);
}

function updateStatus(state) {
  if (!state.statusEl) return;
  if (!state.lastSignal) {
    state.statusEl.textContent = "Waiting";
    return;
  }
  const time = new Date(state.lastSignal.at).toLocaleTimeString();
  state.statusEl.textContent = `${state.lastSignal.kind} via ${state.lastSignal.source} at ${time}`;
}

// ------------------------------------------------------------- settings UI --

function installSettingsPage(state) {
  const render = (root) => renderSettings(root, state);
  if (typeof state.api.settings?.registerPage === "function") {
    state.pageHandle = state.api.settings.registerPage({
      id: "main",
      title: "Completion Sound",
      description: "Play sounds when a Codex turn starts, moves, and finishes.",
      iconSvg:
        '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true">' +
        '<path d="M5 8v4h3l4 3V5L8 8H5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<path d="M14 7.5c.8.7 1.2 1.5 1.2 2.5S14.8 11.8 14 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
        "</svg>",
      render,
    });
  } else {
    state.pageHandle = state.api.settings.register({
      id: "main",
      title: "Completion Sound",
      description: "Play sounds when a Codex turn starts, moves, and finishes.",
      render,
    });
  }
}

function renderSettings(root, state) {
  root.replaceChildren();

  const section = el("section", "flex flex-col gap-2");
  section.appendChild(sectionTitle("Completion Sound"));

  const card = roundedCard();
  card.appendChild(toggleRow("Enabled", state.config.enabled, (enabled) => patchConfig(state, { enabled })));
  card.appendChild(toggleRow("Session log monitor", state.config.monitorSessions, (monitorSessions) => patchConfig(state, { monitorSessions })));
  card.appendChild(toggleRow("Renderer fallback", state.config.rendererFallback, (rendererFallback) => patchConfig(state, { rendererFallback })));
  card.appendChild(toggleRow("Wide chat", state.config.wideChatEnabled, (wideChatEnabled) => patchConfig(state, { wideChatEnabled })));
  card.appendChild(numberRow("Chat max width", state.config.chatMaxWidthRem, "rem", (rem) => {
    return patchConfig(state, { chatMaxWidthRem: clampNumber(rem, 32, 96) });
  }, { min: 32, max: 96, step: 2 }));
  card.appendChild(selectRow("Start Sound", state.config.startSound, Object.keys(MAC_SOUNDS), (startSound) => patchConfig(state, { startSound })));
  card.appendChild(selectRow("Activity Sound", state.config.activitySound, Object.keys(MAC_SOUNDS), (activitySound) => patchConfig(state, { activitySound })));
  card.appendChild(selectRow("Finish Sound", state.config.finishSound, Object.keys(MAC_SOUNDS), (finishSound) => patchConfig(state, { finishSound })));
  card.appendChild(rangeRow("Volume", state.config.volume, 0, 1, 0.05, (volume) => patchConfig(state, { volume })));
  card.appendChild(numberRow("Cooldown", Math.round(state.config.cooldownMs / 1000), "s", (seconds) => {
    return patchConfig(state, { cooldownMs: clampNumber(seconds, 0, 60) * 1000 });
  }));
  card.appendChild(numberRow("Activity cooldown", state.config.activityCooldownMs, "ms", (ms) => {
    return patchConfig(state, { activityCooldownMs: clampNumber(ms, 0, 5000) });
  }, { max: 5000, step: 50 }));

  const test = rowShell("Test", "Play each sound now.");
  const startBtn = button("Test Start");
  startBtn.addEventListener("click", async () => {
    startBtn.disabled = true;
    try {
      await state.api.ipc.invoke("play", { event: "start", source: "settings-test-start", force: true });
      setLastSignal(state, "tested start", "settings");
    } finally {
      startBtn.disabled = false;
    }
  });
  const finishBtn = button("Test Finish");
  finishBtn.addEventListener("click", async () => {
    finishBtn.disabled = true;
    try {
      await state.api.ipc.invoke("play", { event: "finish", source: "settings-test-finish", force: true });
      setLastSignal(state, "tested finish", "settings");
    } finally {
      finishBtn.disabled = false;
    }
  });
  const activityBtn = button("Test Pop");
  activityBtn.addEventListener("click", async () => {
    activityBtn.disabled = true;
    try {
      await state.api.ipc.invoke("play", { event: "activity", source: "settings-test-activity", force: true });
      setLastSignal(state, "tested activity", "settings");
    } finally {
      activityBtn.disabled = false;
    }
  });
  test.right.append(startBtn, activityBtn, finishBtn);
  card.appendChild(test.row);

  const status = rowShell("Status", "");
  state.statusEl = el("div", "text-token-text-secondary text-sm tabular-nums");
  status.right.appendChild(state.statusEl);
  card.appendChild(status.row);
  section.appendChild(card);

  root.appendChild(section);
  updateStatus(state);
}

function toggleRow(label, value, onChange) {
  const parts = rowShell(label, "");
  parts.right.appendChild(switchControl(value !== false, onChange));
  return parts.row;
}

function selectRow(label, value, options, onChange) {
  const parts = rowShell(label, "");
  const select = document.createElement("select");
  select.className =
    "h-token-button-composer rounded-md border border-token-border bg-token-foreground/5 " +
    "px-2 text-sm text-token-text-primary focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-token-focus-border";
  for (const option of options) {
    const opt = document.createElement("option");
    opt.value = option;
    opt.textContent = option;
    select.appendChild(opt);
  }
  select.value = options.includes(value) ? value : options[0];
  select.addEventListener("change", () => onChange(select.value));
  parts.right.appendChild(select);
  return parts.row;
}

function rangeRow(label, value, min, max, step, onChange) {
  const parts = rowShell(label, "");
  const valueEl = el("span", "text-token-text-secondary w-10 text-right text-sm tabular-nums");
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.className = "w-36";
  const paint = () => {
    valueEl.textContent = `${Math.round(Number(input.value) * 100)}%`;
  };
  input.addEventListener("input", paint);
  input.addEventListener("change", () => onChange(Number(input.value)));
  paint();
  parts.right.append(input, valueEl);
  return parts.row;
}

function numberRow(label, value, suffix, onChange, opts = {}) {
  const parts = rowShell(label, "");
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(opts.min ?? 0);
  input.max = String(opts.max ?? 60);
  input.step = String(opts.step ?? 1);
  input.value = String(value);
  input.className =
    "h-token-button-composer w-20 rounded-md border border-token-border bg-token-foreground/5 " +
    "px-2 text-right text-sm text-token-text-primary focus-visible:outline-none " +
    "focus-visible:ring-2 focus-visible:ring-token-focus-border";
  input.addEventListener("change", () => onChange(Number(input.value)));
  const unit = el("span", "text-token-text-secondary text-sm");
  unit.textContent = suffix;
  parts.right.append(input, unit);
  return parts.row;
}

function rowShell(label, description) {
  const row = el("div", "flex items-center justify-between gap-4 p-3");
  const left = el("div", "flex min-w-0 flex-col gap-1");
  const title = el("div", "min-w-0 text-sm text-token-text-primary");
  title.textContent = label;
  left.appendChild(title);
  if (description) {
    const desc = el("div", "text-token-text-secondary min-w-0 text-sm");
    desc.textContent = description;
    left.appendChild(desc);
  }
  const right = el("div", "flex shrink-0 items-center gap-2");
  row.append(left, right);
  return { row, left, right };
}

function button(text) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className =
    "h-token-button-composer rounded-md border border-token-border bg-token-foreground/5 " +
    "px-3 text-sm text-token-text-primary cursor-interaction hover:bg-token-foreground/10 " +
    "disabled:cursor-not-allowed disabled:opacity-50";
  btn.textContent = text;
  return btn;
}

function switchControl(initial, onChange) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "switch");
  const pill = document.createElement("span");
  const knob = document.createElement("span");
  knob.className =
    "rounded-full border border-[color:var(--gray-0)] bg-[color:var(--gray-0)] " +
    "shadow-sm transition-transform duration-200 ease-out h-4 w-4";
  pill.appendChild(knob);
  const apply = (on) => {
    btn.setAttribute("aria-checked", String(on));
    btn.dataset.state = on ? "checked" : "unchecked";
    btn.className =
      "inline-flex items-center text-sm focus-visible:outline-none focus-visible:ring-2 " +
      "focus-visible:ring-token-focus-border focus-visible:rounded-full cursor-interaction";
    pill.className =
      "relative inline-flex shrink-0 items-center rounded-full transition-colors " +
      "duration-200 ease-out h-5 w-8 " +
      (on ? "bg-token-charts-blue" : "bg-token-foreground/20");
    knob.style.transform = on ? "translateX(14px)" : "translateX(2px)";
  };
  apply(initial);
  btn.appendChild(pill);
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const next = btn.getAttribute("aria-checked") !== "true";
    apply(next);
    btn.disabled = true;
    try {
      await onChange(next);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

function sectionTitle(text) {
  const titleRow = el("div", "flex h-toolbar items-center justify-between gap-2 px-0 py-0");
  const inner = el("div", "flex min-w-0 flex-1 flex-col gap-1");
  const title = el("div", "text-base font-medium text-token-text-primary");
  title.textContent = text;
  inner.appendChild(title);
  titleRow.appendChild(inner);
  return titleRow;
}

function roundedCard() {
  const card = el(
    "div",
    "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border",
  );
  card.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";
  return card;
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

// ---------------------------------------------------------------- helpers --

function normalizeConfig(value) {
  const source = isPlainObject(value) ? value : {};
  const next = { ...DEFAULT_CONFIG, ...source };
  next.enabled = next.enabled !== false;
  next.monitorSessions = next.monitorSessions !== false;
  next.rendererFallback = next.rendererFallback !== false;
  next.wideChatEnabled = next.wideChatEnabled !== false;
  next.startSound = isKnownSound(next.startSound) ? next.startSound : DEFAULT_CONFIG.startSound;
  next.activitySound = isKnownSound(next.activitySound) ? next.activitySound : DEFAULT_CONFIG.activitySound;
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
