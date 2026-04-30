# Codex Completion Sound

A Codex++ tweak that plays custom sounds when a Codex turn starts, emits activity, and finishes.

## Sounds

- Start: `assets/codex_not_start.mp3`
- Activity: `assets/codex_not_pop.mp3`
- Finish: `assets/codex_not_finish.mp3`

The tweak also keeps `assets/codex_not.mp3` as a legacy option.

## Install

Copy this folder into your Codex++ tweaks directory, then reload Codex.

macOS:

```sh
cp -R codex-completion-sound "$HOME/Library/Application Support/codex-plusplus/tweaks/com.jumang.completion-sound"
```

Linux:

```sh
cp -R codex-completion-sound "$HOME/.local/share/codex-plusplus/tweaks/com.jumang.completion-sound"
```

Windows:

```powershell
Copy-Item -Recurse codex-completion-sound "$env:APPDATA\\codex-plusplus\\tweaks\\com.jumang.completion-sound"
```

Open `Settings -> Tweaks -> Completion Sound` to choose sounds, adjust volume, tune the activity cooldown, and test playback.

## Requirements

- Codex++ runtime `0.1.1` or newer
- macOS playback uses `afplay`

This is an unofficial Codex++ tweak and is not affiliated with OpenAI.
