const {
  DEFAULT_CONFIG,
  HANDLERS_KEY,
  MAC_SOUNDS,
  RANDOM_POP_SOUND,
  SERVICE_KEY,
  clampNumber,
  isPlainObject,
  normalizeConfig,
} = require('./config');
const {
  activityKey,
  activitySoundFor,
  completionTimeMs,
  eventTimeMs,
  isAssistantActivityPayload,
  normalizeActivityType,
  randomPopSound,
} = require('./activity');

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
      playActivity({
        source: `session-${payload.type || "response-item"}`,
        activityType: normalizeActivityType(payload.type),
        force: false,
      });
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
        ? activitySoundFor(config, opts.activityType)
        : config.finishSound;
    const result = playNativeSound(sound, volume);
    const label = kind === "start" ? "start sound" : kind === "activity" ? "activity sound" : "completion sound";
    api.log.info(label, {
      source: opts.source || "manual",
      activityType: kind === "activity" ? normalizeActivityType(opts.activityType) : null,
      sound,
      resolvedSound: result.sound || null,
      played: result.played,
      reason: result.reason || null,
    });
    return result;
  }

  function playNativeSound(soundName, volume) {
    try {
      if (process.platform === "darwin") {
        const resolvedSound = soundName === RANDOM_POP_SOUND ? randomPopSound() : soundName;
        const configuredFile = MAC_SOUNDS[resolvedSound] || MAC_SOUNDS[DEFAULT_CONFIG.finishSound] || MAC_SOUNDS.Glass;
        const file = path.isAbsolute(configuredFile)
          ? configuredFile
          : path.join(__dirname, "..", configuredFile);
        if (!fs.existsSync(file)) return { played: false, reason: "sound-file-missing", sound: resolvedSound };
        const child = childProcess.spawn(
          "/usr/bin/afplay",
          ["-v", String(volume), file],
          { detached: true, stdio: "ignore" },
        );
        child.unref?.();
        return { played: true, method: "afplay", sound: resolvedSound };
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


module.exports = {
  startMain,
  stopMain,
};
