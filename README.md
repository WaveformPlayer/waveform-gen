<div align="center">

# Waveform Gen

**Pre-generate waveform peak data from audio files.**
CLI and library that pre-computes waveform JSON for WaveformPlayer and WaveformBar — instant visualization, no client-side audio decoding.

![npm version](https://img.shields.io/npm/v/@arraypress/waveform-gen?style=flat-square&labelColor=09090b&color=3f3f46)
![license](https://img.shields.io/npm/l/@arraypress/waveform-gen?style=flat-square&labelColor=09090b&color=3f3f46)

**[Documentation](https://docs.waveformplayer.com/)** · [npm](https://www.npmjs.com/package/@arraypress/waveform-gen)

</div>

---

## Install

```bash
npm install @arraypress/waveform-gen
```

Then generate a `.json` per audio file:

```bash
npx @arraypress/waveform-gen ./audio/*.mp3 --output ./public/waveforms/ --bpm
```

Needs Node 22.12 or later. The library is ES modules with TypeScript
declarations; `require()` loads it too on 22.12+ (Node 22 prints an
`ExperimentalWarning` for that the first time; it still works):

```js
import { generatePeaks } from '@arraypress/waveform-gen';
// or, from CommonJS:
const { generatePeaks } = require('@arraypress/waveform-gen');
```

### Compact peaks and HTML snippets

`--compact` writes `peaks` as one string instead of a number array, and adds
`duration` (seconds) to each JSON file. 1800 peaks are 2,404 characters
(about 2.4 KB a file, against ~18 KB for the default pretty-printed array):

```bash
npx @arraypress/waveform-gen ./audio/*.mp3 --output ./public/waveforms/ --compact
```

```json
{ "peaks": "wp1:AAAAAAAAAAAAAbxcUcRoU0I9ODAqIx8d…", "duration": 122 }
```

`--html` prints a ready-to-paste player per file, so a page shows every
waveform and length without downloading any audio until play. URLs follow
`--root` and `--base-url` (below); no JSON is written unless `--output` asks
for it, and with `--manifest` the manifest is written too:

```bash
npx @arraypress/waveform-gen ./public/audio/*.mp3 --html --base-url /audio/
```

```html
<div data-waveform-player data-url="/audio/little-paris.mp3" data-waveform="wp1:AAAAAAAAAAAAAbxc…" data-duration="122" data-preload="none" data-title="little-paris"></div>
```

The format is `"wp1:"` + base64url (RFC 4648 §5: `A–Z a–z 0–9 - _`, no
padding) of one byte per peak, `byte = round(clamp(peak, 0, 1) × 255)`.
It is quantised from the unrounded peaks, so `--precision` doesn't apply.
`--compact` also works with `--format inline`; a manifest's `peaks` stay
the hex waveform-sounds reads. In code: `encodeCompactPeaks(peaks)` and
`decodeCompactPeaks(string)` (each byte / 255; throws on a string without
the `wp1:` prefix or with characters outside base64url).

### Sounds manifest

For [`@arraypress/waveform-sounds`](https://www.npmjs.com/package/@arraypress/waveform-sounds),
write one manifest for a whole pack instead of a JSON per sound:

```bash
npx @arraypress/waveform-gen ./public/previews/ --recursive \
  --manifest ./public/sounds.json --base-url /previews/
```

```json
{ "version": 1, "sounds": [
  { "url": "/previews/Bass/NW_Bass_Loop_04_128_Fmin.wav", "title": "NW Bass Loop 04",
    "type": "Bass", "bpm": 128, "key": "Fm", "duration": 8.02, "peaks": "1f3a…" }
] }
```

| Flag | Default | |
|---|---|---|
| `--manifest <file>` | | Where to write the manifest. Without `--output`, no per-file JSON is written. |
| `--root <dir>` | deepest folder containing every input | URLs and types are relative to it (also for `--html`). |
| `--base-url <url>` | `/` | Public URL of `--root` (also for `--html`). |
| `--type <name>` | the file's folder | Type for every sound (none for files directly in `--root`). |
| `--manifest-bars <n>` | `64` | Bars per sound, stored as 8-bit hex. |
| `--waveform-base-url <url>` | `--base-url` | Public URL of `--output`; with `--output`, each sound links its full JSON as `waveform`. |

`title`, `bpm` and `key` come from the file name, and are left out rather than
guessed: a BPM is a whole word of 50–220 (`128`, `128bpm`, `128_BPM`), a key a
whole word (`Fmin`, `F#m`, `Bbmin`, `F_minor`, `A#`); a lone `A` or `Eb` only
counts right beside the BPM. With `--bpm`, a detected tempo fills in when the
name has none. A sound is marked `loop: true` when its folder or file name has
the word "loop" or "loops" in it (`Drum Loops/`, `Bass_Loop_01`, `DrumLoop_120`;
not `Loopmasters_Kick`); everything else is a one-shot. In code:
`buildManifest(files, options)`, `parseFilename(name)` and `isLoopPath(rel)`.

## Documentation

Full CLI options, library API and the JSON output format live in the docs.

### -> [docs.waveformplayer.com](https://docs.waveformplayer.com/)

[Overview](https://docs.waveformplayer.com/extensions/gen/) · [Library](https://docs.waveformplayer.com/extensions/gen/library/) · [Output format](https://docs.waveformplayer.com/extensions/gen/output/)

## License

MIT © [ArrayPress](https://github.com/arraypress)
