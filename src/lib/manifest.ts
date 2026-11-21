/**
 * @module manifest
 * @description Sounds manifests for `@arraypress/waveform-sounds`: one JSON
 * per pack listing every sound with its URL, a title, type, BPM and key read
 * from the file name, its duration and low-resolution peaks — so a list of
 * hundreds of previews loads from one request instead of one per sound.
 *
 * The shape and the peak encoding must match what waveform-sounds reads
 * (`parseManifest` / `decodePeaks` in its `src/js/data/sounds.js`):
 *
 *     { "version": 1, "sounds": [ { "url", "title", "type"?, "bpm"?, "key"?,
 *       "duration", "peaks": "<hex>", "waveform"? } ] }
 */

import {basename, dirname, relative, resolve, sep, isAbsolute} from 'node:path';
import {generatePeaks} from './generate.js';

/** What {@link parseFilename} reads from a file name. */
export interface ParsedFilename {
    title: string;
    bpm: number | null;
    key: string | null;
}

/** One input path for {@link commonRoot}. */
export interface RootInput {
    /** Absolute path. */
    path: string;
    /** False for a file: its parent directory is used. */
    isDir: boolean;
}

/** An analysed file, as {@link manifestEntry} takes it. */
export interface ManifestAnalysis {
    /** Path relative to the manifest root. */
    rel: string;
    /** Normalised peaks (0..1), any resolution. */
    peaks: number[];
    /** Seconds. */
    duration?: number | null;
    /** Detected tempo, used only when the file name has none. */
    bpm?: number | null;
}

/** Options for {@link manifestEntry}. */
export interface ManifestEntryOptions {
    /** Public URL of the root (default '/'). */
    baseUrl?: string;
    /** Bars in the `peaks` hex (default 64). */
    bars?: number;
    /**
     * Type for every sound; default: the name of the file's folder, none for
     * a file directly in the root.
     */
    type?: string | null;
    /** URL of the file's full peaks JSON. */
    waveform?: string;
}

/** One sound in a manifest. Keys appear in this order in the JSON. */
export interface ManifestEntry {
    url: string;
    title: string;
    type?: string;
    bpm?: number;
    key?: string;
    loop?: true;
    duration?: number;
    /** 8-bit hex peaks, two characters per bar. */
    peaks: string;
    waveform?: string;
}

/** An entry with the source path it is sorted by, for {@link createManifest}. */
export interface ManifestItem {
    rel: string;
    entry: ManifestEntry;
}

/** A waveform-sounds manifest, as its `SoundsManifest`. */
export interface SoundsManifest {
    version: number;
    sounds: ManifestEntry[];
}

/** Options for {@link buildManifest}. */
export interface BuildManifestOptions {
    /**
     * Directory URLs and types are relative to; default: the deepest folder
     * containing every file.
     */
    root?: string;
    /** Public URL of `root` (default '/'). */
    baseUrl?: string;
    /** Bars per sound (default 64). */
    bars?: number;
    /** Type for every sound (default: folder name). */
    type?: string;
    /** Detect tempo for files whose name carries none (default false). */
    detectBPM?: boolean;
    /** Resolution decoded at before downsampling to `bars` (default 1800). */
    samples?: number;
    /** Returns the URL of a file's full peaks JSON, if there is one. */
    waveform?: (file: string, rel: string) => string | undefined;
}

/** Manifest format version, as waveform-sounds' `SoundsManifest.version`. */
export const MANIFEST_VERSION = 1;

/** Default number of bars per sound: a sound browser row draws ~48–64. */
export const DEFAULT_MANIFEST_BARS = 64;

// ============================================
// Peaks
// ============================================

/**
 * Encode peaks as an 8-bit hex string, two lowercase characters per bar.
 *
 * Byte-for-byte the same as waveform-sounds' `encodePeaks`: each value is
 * clamped to 0..1 (non-numbers count as 0), scaled by 255 and rounded.
 *
 * @param peaks - Values 0..1.
 * @returns Hex string ('' for a non-array).
 */
export function encodePeaks(peaks: number[]): string {
    if (!Array.isArray(peaks)) return '';
    let out = '';
    for (const p of peaks) {
        const v = Math.round(Math.min(Math.max(Number(p) || 0, 0), 1) * 255);
        out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
}

/**
 * Downsample peaks to `count` bars, keeping the loudest value in each bucket
 * so a short transient (a kick, a snare hit) still shows. Same bucketing as
 * waveform-sounds' `resample` (`src/js/dom/draw.js`), so the bars it would draw
 * from full-resolution peaks are the bars stored here.
 *
 * @param peaks - Values 0..1.
 * @param count - Bars wanted; a positive integer.
 * @returns `count` values (`[]` for no peaks).
 */
export function resamplePeaks(peaks: number[], count: number): number[] {
    if (!peaks?.length || count <= 0) return [];
    if (peaks.length === count) return peaks.slice();
    const out = new Array(count);
    const step = peaks.length / count;
    for (let i = 0; i < count; i++) {
        const start = Math.floor(i * step);
        const end = Math.max(start + 1, Math.floor((i + 1) * step));
        let m = 0;
        for (let j = start; j < end && j < peaks.length; j++) if (peaks[j] > m) m = peaks[j];
        out[i] = m;
    }
    return out;
}

// ============================================
// File names
// ============================================

/** Tempo range a file-name number has to fall in to be read as BPM. */
const BPM_MIN = 50;
const BPM_MAX = 220;

/** Characters that separate words in a sample's file name. */
const SEPARATORS = /[\s_-]+/;

/** Brackets and trailing punctuation stripped from a token before matching. */
const TOKEN_PUNCT = /^[([{]+|[)\]},.;:!]+$/g;

const MODE_WORD = /^(min|minor|maj|major)$/i;

/** A file-name number that may be the BPM, and the `bpm` word beside it (-1: none). */
interface BpmCandidate {
    i: number;
    n: number;
    marker: number;
}

/**
 * Classify one token as a key.
 *
 * Returns `strong` for spellings that are keys wherever they appear, `weak`
 * for ones that are also ordinary words or labels (a lone "A", "Ab", "Am")
 * and only count beside a BPM, or null.
 *
 * - strong: a mode word (`Fmin`, `cmaj`, `F#minor`, `Bbmin`), a sharp (`F#`,
 *   `A#m`), a flat with `m` (`Bbm`), or `[A-G]m` with an upper-case root and
 *   lower-case `m` (`Fm`; not `FM`, the synth, nor `fm`).
 * - weak: `A`–`G` alone, a flat alone (`Eb`), and `Am` (the English word).
 *
 * @param token - Punctuation-stripped token.
 */
function keyToken(token: string): {key: string, strength: 'strong'|'weak'} | null {
    // Root, accidental, mode — the mode glued on (Fmin) or absent.
    const m = token.match(/^([A-Ga-g])([#♯b♭]?)(min|minor|maj|major|m)?$/i);
    if (!m) return null;
    const [, rootRaw, accRaw, mode] = m;
    const root = rootRaw.toUpperCase();
    const acc = accRaw === '♯' ? '#' : accRaw === '♭' ? 'b' : accRaw.toLowerCase();
    const upperRoot = rootRaw === root;
    // `[#♯b♭]` matched case-insensitively also took a 'B' ("BB"): not a key.
    if (accRaw === 'B') return null;

    const minor = mode ? /^m(in(or)?)?$/i.test(mode) : false;
    const key = root + acc + (minor ? 'm' : '');

    if (mode && MODE_WORD.test(mode)) return {key, strength: 'strong'};
    if (mode) {
        // A bare `m`: only `Xm` / `X#m` / `Xbm`, upper root, lower m.
        if (mode !== 'm' || !upperRoot) return null;
        if (acc) return {key, strength: 'strong'};
        return {key, strength: token === 'Am' ? 'weak' : 'strong'};
    }
    if (acc === '#') return {key, strength: 'strong'};
    if (!upperRoot) return null;
    return {key, strength: 'weak'};
}

/**
 * Read the title, BPM and key a sample's file name carries.
 *
 * Words are the parts between spaces, `_` and `-`. A BPM is a whole word of
 * 50–220 (`128`), optionally marked (`128bpm`, `128 BPM`, `bpm128`); a marked
 * one wins over a bare one, a bare one with a leading zero (`090`) is taken
 * as an index, and two different bare candidates with nothing to choose
 * between them give no BPM. A key is a whole word (or a root followed by a
 * mode word, `F_minor`); ambiguous spellings (a lone `A`, `Eb`, `Am`) count
 * only right beside the BPM. The title is what's left: extension dropped,
 * separators turned into single spaces, the BPM and key words removed.
 *
 * Misses are preferred over false positives: an unknown BPM or key is left
 * out of the manifest, while a wrong one files the sound under the wrong
 * filter.
 *
 * @example
 * parseFilename('NW_Bass_Loop_04_128_Fmin.wav')
 * // → { title: 'NW Bass Loop 04', bpm: 128, key: 'Fm' }
 *
 * @param name - A file name or path (only the base name is read).
 */
export function parseFilename(name: string): ParsedFilename {
    const file = String(name ?? '').split(/[\\/]/).pop()!;
    const stem = file.replace(/\.[a-z0-9]{1,5}$/i, '');
    const raw = stem.split(SEPARATORS).filter(Boolean);
    const tokens = raw.map((t) => t.replace(TOKEN_PUNCT, ''));
    const used = new Set<number>();

    // ---- BPM ----
    const inRange = (n: number) => n >= BPM_MIN && n <= BPM_MAX;
    let bpm: number | null = null;
    let bpmAt = -1;
    const marked: BpmCandidate[] = [];
    const bare: BpmCandidate[] = [];
    tokens.forEach((t, i) => {
        let m: RegExpMatchArray | null;
        if ((m = t.match(/^(\d{2,3})bpm$/i)) || (m = t.match(/^bpm(\d{2,3})$/i))) {
            if (inRange(+m[1])) marked.push({i, n: +m[1], marker: -1});
        } else if (/^\d{2,3}$/.test(t)) {
            const n = +t;
            if (!inRange(n)) return;
            if (/^bpm$/i.test(tokens[i + 1] ?? '')) marked.push({i, n, marker: i + 1});
            else if (/^bpm$/i.test(tokens[i - 1] ?? '')) marked.push({i, n, marker: i - 1});
            else if (!t.startsWith('0')) bare.push({i, n, marker: -1});
        }
    });
    let pick = marked[0];
    if (!pick && bare.length) {
        const values = new Set(bare.map((b) => b.n));
        if (values.size === 1) {
            pick = bare[bare.length - 1];
        } else {
            // Several: only the one sitting beside a key is a confident read.
            const byKey = bare.filter((b) =>
                [tokens[b.i - 1], tokens[b.i + 1]].some((t) => t && keyToken(t)?.strength === 'strong'));
            if (byKey.length === 1) pick = byKey[0];
        }
    }
    if (pick) {
        bpm = pick.n;
        bpmAt = pick.i;
        used.add(pick.i);
        if (pick.marker >= 0) used.add(pick.marker);
    }

    // ---- Key ----
    let key: string | null = null;
    const bpmSpan = [...used];
    const besideBpm = (i: number, len = 1) =>
        bpmAt >= 0 && bpmSpan.some((b) => b === i - 1 || b === i + len);
    for (let i = 0; i < tokens.length && !key; i++) {
        if (used.has(i)) continue;
        const t = tokens[i];
        const next = tokens[i + 1];
        // Root then a separate mode word: `F_minor`, `C# Major`.
        if (next && MODE_WORD.test(next) && !used.has(i + 1)) {
            const k = keyToken(t + next);
            if (k) {
                key = k.key;
                used.add(i).add(i + 1);
                break;
            }
        }
        const k = keyToken(t);
        if (!k) continue;
        if (k.strength === 'strong' || besideBpm(i)) {
            key = k.key;
            used.add(i);
        }
    }

    // ---- Title ----
    let title = raw.filter((_, i) => !used.has(i)).join(' ').trim();
    if (!title) title = raw.join(' ').trim() || stem;

    return {title, bpm, key};
}

// ============================================
// Paths & URLs
// ============================================

/**
 * Join a base URL and a relative file path into a public URL: forward
 * slashes, each path segment URL-encoded (`Drum Loops/kick 1.wav` →
 * `Drum%20Loops/kick%201.wav`). The base is used as given apart from gaining
 * a trailing slash, so it can be a path (`/audio/`) or an origin
 * (`https://cdn.example.com/packs`).
 *
 * @param relPath - Path relative to the root, either separator.
 * @param baseUrl - Public URL of the root.
 */
export function fileUrl(relPath: string, baseUrl: string = '/'): string {
    let base = baseUrl == null ? '/' : String(baseUrl);
    if (base && !base.endsWith('/')) base += '/';
    const path = String(relPath).split(/[\\/]+/).filter(Boolean).map(encodeURIComponent).join('/');
    return base + path;
}

/**
 * Natural, case-insensitive path order: `Loop 2` before `Loop 10`, folders
 * compared segment by segment. Ties fall back to plain code-point order so
 * the result never depends on input order.
 *
 * @param a
 * @param b
 */
export function naturalCompare(a: string, b: string): number {
    const sa = String(a).split(/[\\/]/);
    const sb = String(b).split(/[\\/]/);
    for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
        const c = COLLATOR.compare(sa[i], sb[i]);
        if (c) return c;
    }
    return sa.length - sb.length || (a < b ? -1 : a > b ? 1 : 0);
}

const COLLATOR = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});

/**
 * The deepest directory containing every given path. With `isDir` false for
 * an entry, its parent directory is used (a file argument contributes its
 * folder). Returns null when the paths share no root (different drives).
 *
 * @param entries - Absolute paths.
 */
export function commonRoot(entries: RootInput[]): string | null {
    let parts: string[] | null = null;
    for (const {path, isDir} of entries) {
        const dir = resolve(isDir ? path : dirname(path));
        const segs = dir.split(sep);
        if (!parts) {
            parts = segs;
            continue;
        }
        let n = 0;
        while (n < parts.length && n < segs.length && parts[n] === segs[n]) n++;
        parts = parts.slice(0, n);
    }
    if (!parts || !parts.length) return null;
    // '/' splits to ['', ''] → [''] after trimming; keep it a real root.
    return parts.join(sep) || sep;
}

// ============================================
// Entries
// ============================================

/**
 * Is this file a loop, by its path? True when a folder or the file name has
 * the word "loop" or "loops" in it: `Drum Loops/kick.wav`,
 * `Bass_Loop_01.wav`, `DrumLoop_120.wav` (camelCase is split into words
 * first). A word, not a substring: `Loopmasters_Kick.wav` is not a loop.
 * Everything else is left unmarked, which waveform-sounds reads as a
 * one-shot. The name is the evidence, the same as for BPM and key: a tempo
 * in the name does NOT make a file a loop.
 *
 * @param rel - Path relative to the manifest root.
 */
export function isLoopPath(rel: string): boolean {
    return String(rel)
        .split(/[\\/]+/)
        .map((part) => part.replace(/\.[a-z0-9]+$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2'))
        .some((part) => /(^|[^a-z])loops?([^a-z]|$)/i.test(part));
}

/**
 * Build one manifest entry from an analysed file. Pure: no decoding.
 *
 * @param analysis
 * @param analysis.rel - Path relative to the manifest root.
 * @param analysis.peaks - Normalised peaks (0..1), any resolution.
 * @param [analysis.duration] - Seconds.
 * @param [analysis.bpm] - Detected tempo, used only when the
 *   file name has none.
 * @param options
 * @param [options.baseUrl='/'] - Public URL of the root.
 * @param [options.bars=64] - Bars in the `peaks` hex.
 * @param [options.type] - Type for every sound; default: the name
 *   of the file's folder, none for a file directly in the root.
 * @param [options.waveform] - URL of the file's full peaks JSON.
 */
export function manifestEntry(analysis: ManifestAnalysis, options: ManifestEntryOptions = {}): ManifestEntry {
    const rel = String(analysis.rel).split(/[\\/]+/).filter(Boolean).join('/');
    const bars = options.bars ?? DEFAULT_MANIFEST_BARS;
    const parsed = parseFilename(rel);
    const folders = rel.split('/').slice(0, -1);

    const entry = {url: fileUrl(rel, options.baseUrl ?? '/'), title: parsed.title} as ManifestEntry;
    const type = options.type || folders[folders.length - 1];
    if (type) entry.type = type;
    const bpm = parsed.bpm ?? (Number.isFinite(analysis.bpm) && analysis.bpm! > 0 ? analysis.bpm : null);
    if (bpm != null) entry.bpm = bpm;
    if (parsed.key) entry.key = parsed.key;
    if (isLoopPath(rel)) entry.loop = true;
    if (Number.isFinite(analysis.duration)) entry.duration = Math.round(analysis.duration! * 100) / 100;
    entry.peaks = encodePeaks(resamplePeaks(analysis.peaks, bars));
    if (options.waveform) entry.waveform = options.waveform;
    return entry;
}

/**
 * Wrap entries as a manifest, sorted by their source paths (natural order).
 *
 * @param items
 */
export function createManifest(items: ManifestItem[]): SoundsManifest {
    const sorted = [...items].sort((a, b) => naturalCompare(a.rel, b.rel));
    return {version: MANIFEST_VERSION, sounds: sorted.map((x) => x.entry)};
}

/**
 * Decode audio files and build a waveform-sounds manifest.
 *
 * @param files - Audio file paths.
 * @param options
 * @param [options.root] - Directory URLs and types are relative to;
 *   default: the deepest folder containing every file.
 * @param [options.baseUrl='/'] - Public URL of `root`.
 * @param [options.bars=64] - Bars per sound.
 * @param [options.type] - Type for every sound (default: folder name).
 * @param [options.detectBPM=false] - Detect tempo for files whose
 *   name carries none.
 * @param [options.samples=1800] - Resolution decoded at before
 *   downsampling to `bars`.
 * @param [options.waveform]
 *   - Returns the URL of a file's full peaks JSON, if there is one.
 * @throws When a file can't be decoded, or lies outside `root`.
 */
export async function buildManifest(files: string[], options: BuildManifestOptions = {}): Promise<SoundsManifest> {
    const bars = options.bars == null ? DEFAULT_MANIFEST_BARS : Number(options.bars);
    if (!Number.isInteger(bars) || bars < 1) {
        throw new Error(`[WaveformGen] bars must be a positive integer, got: ${options.bars}`);
    }
    const abs = files.map((f) => resolve(f));
    const root = options.root
        ? resolve(options.root)
        : commonRoot(abs.map((path) => ({path, isDir: false}))) ?? process.cwd();

    const items: ManifestItem[] = [];
    for (const file of abs) {
        const rel = relativeTo(root, file);
        const result = await generatePeaks(file, {
            samples: options.samples,
            precision: -1,
            detectBPM: options.detectBPM,
        });
        const entry = manifestEntry({rel, ...result}, {
            baseUrl: options.baseUrl,
            bars,
            type: options.type,
            waveform: options.waveform?.(file, rel),
        });
        items.push({rel, entry});
    }
    return createManifest(items);
}

/**
 * A file's path relative to the manifest root, with `/` separators.
 *
 * @param root - Absolute root directory.
 * @param file - Absolute file path.
 * @throws When the file is not inside the root.
 */
export function relativeTo(root: string, file: string): string {
    const rel = relative(root, file);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
        throw new Error(`[WaveformGen] ${basename(file)} is outside the manifest root ${root} — set --root to a folder containing it`);
    }
    return rel.split(sep).join('/');
}

