# Remote Meeting Recorder

Record your online meetings inside Obsidian. This desktop-only, macOS plugin
captures **system audio (what the other participants say)** and **your
microphone** at the same time, keeps every recording safe across crashes and
reloads, and links the audio — and an optional local transcript — straight into
your notes.

日本語のドキュメントは [README.ja.md](README.ja.md) にあります。

## Why a helper binary?

Electron/Chromium alone cannot reliably capture macOS system audio, so recording
is handled by a small external helper, `sysrec`, written in Swift on top of
Apple's **Core Audio process taps**. The plugin runs it as a subprocess and treats the
filesystem (`~/.meeting-recorder/`) as the source of truth, so an in-progress
recording survives an Obsidian reload or crash. The plugin never ships or
downloads a prebuilt binary; you build `sysrec` from the source in this
repository (see [Installation](#installation)).

## Features

- Record **system audio + microphone** together, or either one alone.
- **Crash-safe sessions**: recordings are recovered and finalized after a reload,
  a crash, or closing the laptop lid — the plugin does not stop recording on
  unload.
- Automatic offline **mixing** of the two tracks into a single `m4a`, with
  `remix` recovery if mixing fails and rescue-by-rename if only one side exists.
- **Live mic waveform** and an always-on-top mini control window so you can stop
  the recording without leaving your meeting app.
- **Embed on stop**: insert `![[recording.m4a]]` into a note you choose.
- **Local transcription** with the bundled-at-build-time
  [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (fully offline).
- A built-in **diagnostics (doctor)** panel that checks the binary, permissions,
  devices, and transcription setup.

## Requirements

- **macOS** with Core Audio process taps (macOS 14.4+; developed on macOS 15/26,
  Apple Silicon). Desktop only.
- **Xcode command line tools** (`swiftc`) to build the `sysrec` helper.
- Optional, for transcription: `whisper-cpp` (`brew install whisper-cpp`) or a
  local build via `npm run build-whisper`, plus a ggml model (downloadable from
  the doctor panel).
- **Microphone permission** for Obsidian (macOS asks on first recording). Screen
  recording is not required — system audio is captured via Core Audio taps.

## Installation

This plugin is distributed outside the official community store (it relies on a
native macOS helper), so install it with **BRAT** or from source. Either way you
still build the `sysrec` helper once.

### Via BRAT (recommended)

No Xcode or terminal needed — the `sysrec` helper is downloaded with one click.

1. Install the **BRAT** community plugin.
2. In BRAT, "Add a beta plugin" with this repository:
   `ryukyuhub/obsidian-remote-meeting-recorder`. BRAT installs `main.js`,
   `manifest.json`, and `styles.css` from the latest release.
3. Enable the plugin, open its settings, and run **Diagnostics (doctor)**. If the
   `sysrec` helper is missing, click **"sysrec を取得"** — it downloads the
   ad-hoc-signed helper from the latest release and installs it.
4. Grant **Microphone** permission to Obsidian when prompted.

The bundled `sysrec` is ad-hoc signed (not notarized). It is fetched over HTTPS
and run as a subprocess by Obsidian; macOS does not prompt for Gatekeeper in this
path, and the doctor clears any quarantine attribute after download.

### From source

1. Clone this repository into your vault's plugins folder (or clone elsewhere and
   symlink it):

   ```sh
   git clone https://github.com/ryukyuhub/obsidian-remote-meeting-recorder.git
   cd obsidian-remote-meeting-recorder
   npm install
   npm run build            # builds main.js
   npm run build-sysrec     # builds the sysrec helper (requires swiftc)
   ```

2. Place (or symlink) the folder at
   `<vault>/.obsidian/plugins/remote-meeting-recorder`.

3. Enable **Remote Meeting Recorder** in Obsidian → Settings → Community plugins.

4. Open the plugin settings and run **Diagnostics (doctor)** to verify the
   binary, permissions, and (optionally) transcription.

5. Grant **Microphone** permission to Obsidian when prompted
   (System Settings → Privacy & Security → Microphone). Screen recording is not
   required — system audio is captured via Core Audio taps.

## Usage

1. Open the **Remote Meeting Recorder** view (ribbon icon or command palette).
2. Choose the source (system / microphone / both), the save folder, and an embed
   target note.
3. Confirm the participant-consent checkbox, then press **Record**.
4. Press **Stop** (in the view or the mini control window). The recording is
   saved, embedded into your note, and — if enabled — transcribed locally.

You can also right-click any note in the file explorer and choose
**"ここに会議録音を埋め込む"** to start a recording that embeds into that note.

## Troubleshooting

Run **Diagnostics (doctor)** from the plugin settings first — it reports the most
common issues.

- **"Microphone permission not granted"** — enable Obsidian under System
  Settings → Privacy & Security → Microphone, then fully restart Obsidian.
- **`sysrec` not found** — run `npm run build-sysrec` (requires `swiftc`).
- **Transcription does nothing** — install `whisper-cpp`
  (`brew install whisper-cpp`) and download a model from the doctor panel. GUI
  apps do not inherit your shell `PATH`, so the plugin also looks in
  `/opt/homebrew/bin` automatically.
- **Recording stops unexpectedly** — closing the laptop lid sleeps the machine
  and stops capture.

## Development

```sh
npm install
npm run build-sysrec     # build the sysrec helper (requires swiftc / macOS)
npm run dev              # esbuild watch (emits main.js at the repo root)
npm run build            # type-check + production build
npm run lint             # eslint (mirrors Obsidian's release checks)
npm run test:e2e         # fake-binary end-to-end tests (no real recording)
```

Symlink into a test vault for hot-reload development:

```sh
ln -s "$(pwd)" <vault>/.obsidian/plugins/remote-meeting-recorder
```

## Architecture

- **`sysrec`** (`native/sysrec/`, Swift/Core Audio taps) is the recording engine,
  spawned as a subprocess. It outlives the renderer, so all session state lives on
  disk under `~/.meeting-recorder/`.
- The **state machine** (start / stop / mix / sweep / watch / restore) is
  reimplemented in TypeScript over `child_process` and `fs`, prioritizing never
  losing a recording.
- **Transcription** decodes the archived `m4a` to 16 kHz mono PCM and runs
  whisper.cpp locally.

The full design (Japanese) is in `リモート会議録音プラグイン 設計書.md`.

## License

[MIT](LICENSE) © Ryukyu HUB Inc.
