# AGENTS.md

## Project Summary

This repository contains the `com.jumang.completion-sound` Codex++ tweak.

The tweak runs in both the Codex main and renderer processes. Its main purpose is to play notification sounds for Codex activity:

- Start sound when a user prompt / new turn starts.
- Activity pop sound when Codex emits assistant activity, tool calls, function call output, or similar progress events.
- Finish sound when a Codex turn completes.

The tweak also widens the Codex chat column by overriding `--thread-content-max-width` in the Electron renderer. The default width is `64rem`, configurable from the tweak settings.

## Current Feature Set

- Main-process session log monitor watches Codex session JSONL files under `~/.codex/sessions` and `~/.codex/archived_sessions`.
- Renderer fallback listens for Codex UI/message activity when session events are unavailable.
- Sounds are configurable from `Settings -> Tweaks -> Completion Sound`.
- Volume, cooldown, activity cooldown, renderer fallback, session monitor, and wide chat settings are configurable.
- Activity pop defaults to `assets/codex_not_pop.aiff`, a faded AIFF version used to avoid short MP3 cutoff/click artifacts with `afplay`.

## Sound Assets

- Start: `assets/codex_not_start.mp3`
- Activity default: `assets/codex_not_pop.aiff`
- Activity legacy: `assets/codex_not_pop.mp3`
- Finish: `assets/codex_not_finish.mp3`
- Legacy finish/default: `assets/codex_not.mp3`

## Local Install Path

The live tweak copy on macOS is expected at:

```sh
~/Library/Application Support/codex-plusplus/tweaks/com.jumang.completion-sound
```

When changing the tweak locally, copy updated files there and reload Codex or let Codex++ hot reload pick up the change.

## Maintenance Notes

- Keep changes scoped. This tweak should remain primarily a notification/layout tweak.
- Do not reintroduce the removed rainbow/task-heat highlighting feature unless explicitly requested; it caused visual instability.
- Do not create GitHub releases or `v*` tags unless the user explicitly asks. Releases and tags were intentionally removed.
- It is okay to commit and push when the user asks to apply changes to git.
- Run `node -c index.js` and `git diff --check` before committing.
- After copying to the live Codex++ tweak directory, check `~/Library/Application Support/codex-plusplus/log/main.log` for reload errors.
