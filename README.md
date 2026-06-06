# Clip Cutter

A local, transcript-driven video clipping tool. Upload a video, transcribe it, then
highlight parts of the transcript in different colors — each color becomes one exported
clip. Non-contiguous highlights of the same color are stitched together with hard cuts.

Optionally let AI auto-select clips from your guidance, burn in one-line subtitles, and
preview everything before exporting. Original aspect ratio is preserved.

## Features

- **Transcription** — word-level timestamps via Deepgram (audio extracted in-browser).
- **Color highlighting** — paint the transcript; each color = one output clip. A word can
  belong to multiple clips (shown as a split background).
- **AI auto-clips** — describe what you want and an OpenRouter model picks the clips for you.
- **Subtitles** — optional burned-in captions (white text, black background, one line),
  timed from the word timestamps. Live preview in the player.
- **Native ffmpeg export** — fast cutting/concatenation/overlay using your system ffmpeg.
- **Sessions** — your edits are saved per-file in the browser; reopen a file to restore.

## Requirements

- [Node.js](https://nodejs.org/) (v18+)
- [ffmpeg](https://ffmpeg.org/) on your `PATH` (`brew install ffmpeg` on macOS)
- A [Deepgram](https://console.deepgram.com/) API key (transcription)
- An [OpenRouter](https://openrouter.ai/keys) API key (optional — only for AI auto-clips)

## Setup

```bash
cp config.example.js config.js
# edit config.js and paste your keys
node serve.mjs
```

Then open <http://localhost:4201>.

## Workflow

1. **Upload** a video.
2. **Transcribe** it (or restore a previous session for the same file).
3. **AI Clips** (optional) — let the model pick clips from your guidance, or skip to manual.
4. **Mark Clips** — drag across transcript words to assign colors; tick "subtitles" per clip.
5. **Export** — rename files if you like, then export. Each color renders as one `.mp4`.

## Notes

- `config.js` holds your API keys and is **gitignored** — never commit it.
- Export runs through the local server using native ffmpeg, so it must be running.
- Subtitles are rendered to PNGs in the browser and composited with ffmpeg's `overlay`
  filter, so they work even on minimal ffmpeg builds without libass/freetype.
- `export-clips.mjs` is a standalone CLI alternative: `node export-clips.mjs video.mp4 spec.json`.
