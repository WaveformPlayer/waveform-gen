/**
 * @module compact
 * @description Compact peaks for WaveformPlayer 2.0's `data-waveform`
 * attribute: `"wp1:" + base64url(bytes)`, one unsigned byte per peak.
 *
 * - Each peak is clamped to 0..1 (a non-number counts as 0), scaled by 255
 *   and rounded: byte = Math.round(peak × 255).
 * - The bytes are base64url-encoded with the RFC 4648 §5 alphabet
 *   (`A–Z a–z 0–9 - _`) and no `=` padding, so the string is safe in an HTML
 *   attribute, a URL or JSON without escaping.
 * - 1800 peaks are 2404 characters (4 for the prefix, 2400 for the bytes),
 *   against ~9 KB as a JSON array at the default 2 decimal places.
 *
 * The format is fixed; a different encoding gets a different prefix.
 */

/** The version prefix every compact peaks string starts with. */
export const COMPACT_PEAKS_PREFIX = 'wp1:';

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * Encode peaks as a compact `wp1:` string.
 *
 * @param peaks - Peak magnitudes 0..1, as {@link generatePeaks} returns
 *   them. Values outside 0..1 are clamped; anything that isn't a finite
 *   number counts as 0.
 * @returns `"wp1:"` followed by the base64url bytes, unpadded
 *   (`"wp1:"` alone for no peaks).
 * @throws TypeError when `peaks` is not an array.
 *
 * @example
 * encodeCompactPeaks([0, 0.5, 1]); // 'wp1:AID_'
 */
export function encodeCompactPeaks(peaks: readonly number[]): string {
    if (!Array.isArray(peaks)) {
        throw new TypeError(`[WaveformGen] encodeCompactPeaks expects an array of numbers, got: ${typeof peaks}`);
    }
    const bytes = new Uint8Array(peaks.length);
    for (let i = 0; i < peaks.length; i++) {
        const p = Number(peaks[i]);
        bytes[i] = Number.isFinite(p) ? Math.round(Math.min(Math.max(p, 0), 1) * 255) : 0;
    }
    return COMPACT_PEAKS_PREFIX + Buffer.from(bytes).toString('base64url');
}

/**
 * Decode a compact `wp1:` string back into peaks.
 *
 * @param value - A string from {@link encodeCompactPeaks}.
 * @returns Peaks 0..1, each byte / 255 (within 1/255 of what was encoded).
 * @throws Error when the string lacks the `wp1:` prefix, contains a
 *   character outside the base64url alphabet (including `=` padding), or
 *   has a length no byte sequence encodes to.
 *
 * @example
 * decodeCompactPeaks('wp1:AID_'); // [0, 0.50196…, 1]
 */
export function decodeCompactPeaks(value: string): number[] {
    if (typeof value !== 'string' || !value.startsWith(COMPACT_PEAKS_PREFIX)) {
        const shown = typeof value === 'string' ? JSON.stringify(value.slice(0, 12)) : typeof value;
        throw new Error(`[WaveformGen] Compact peaks must start with "${COMPACT_PEAKS_PREFIX}", got: ${shown}`);
    }
    const body = value.slice(COMPACT_PEAKS_PREFIX.length);
    if (!BASE64URL.test(body)) {
        const bad = body.match(/[^A-Za-z0-9_-]/)![0];
        throw new Error(`[WaveformGen] Compact peaks contain an invalid character ${JSON.stringify(bad)} (base64url, no padding)`);
    }
    // Node's decoder is lenient: it drops a stray trailing character and
    // ignores leftover bits. Round-tripping catches both, so a truncated or
    // corrupted string is an error instead of quietly different peaks.
    const bytes = Buffer.from(body, 'base64url');
    if (bytes.toString('base64url') !== body) {
        throw new Error(`[WaveformGen] Compact peaks are not valid base64url (length ${body.length} or trailing bits are wrong; truncated?)`);
    }
    return Array.from(bytes, (b) => b / 255);
}
