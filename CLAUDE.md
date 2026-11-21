# CLAUDE.md — @arraypress/waveform-gen

Node CLI + library that pre-renders WaveformPlayer peaks from audio files, so
pages draw waveforms without decoding audio. TypeScript in `src/`, built by
`tsc` into `dist/` (`prepack` builds, so `npm pack`/`publish` always ship a fresh
`dist/`; `dist/` is gitignored).

- `src/lib/generate.ts` — decode + `generatePeaks` (0..1 magnitudes, loudest = 1).
- `src/lib/manifest.ts` — waveform-sounds manifests: hex peaks, default
  `DEFAULT_MANIFEST_BARS = 128` (3.1.0; `--manifest-bars 64` for smaller files).
- `src/lib/compact.ts` — `encodeCompactPeaks`/`decodeCompactPeaks`, the `wp1:`
  format (base64url, one byte per peak) — same names as the core's
  `WaveformPlayer.utils`.
- `src/bin/waveform-gen.ts` — the CLI (`waveform-gen`, with the shebang).

## Commands
- `npm test` — builds, then Vitest (library tests import `src/`, CLI tests run
  the built `dist/bin`). `npm run typecheck`, `npm run lint` (Biome).

## Rules
- **Default output is a contract**: without `--compact`/`--html`/manifest
  options, stdout, written files and exit codes must stay byte-identical across
  releases — compare against the previous published version
  (`npx @arraypress/waveform-gen@<prev>`) on the same inputs before releasing.
- Manifests stay the 64/128-bar **hex** format waveform-sounds reads; the
  parity tests in `test/manifest.test.js` import waveform-sounds' live source
  from `../waveform-sounds` (sibling checkout) — keep them passing when sounds
  changes how it decodes or draws peaks.
- Node `>=22.12` (ESM; `require()` of it works there). Runtime dependency:
  `audio-decode` only — don't add more without a reason.
- Version history: 2.x was used under this name before WaveformPlayer 2.0, so
  gen ships 3.x alongside the family's 2.x.
- A change gets a test and a CHANGELOG entry. Family-wide releases: the
  `waveform-release` skill.
