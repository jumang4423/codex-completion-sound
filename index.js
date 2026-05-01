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

const { startMain, stopMain } = require('./src/main');
const { startRenderer, stopRenderer } = require('./src/renderer');

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
