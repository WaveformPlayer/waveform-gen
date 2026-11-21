import { describe, it, expect } from 'vitest';
import { encodeCompactPeaks, decodeCompactPeaks, COMPACT_PEAKS_PREFIX } from '../src/lib/index.ts';

/**
 * The `wp1:` format is a contract with WaveformPlayer 2.0's `data-waveform`
 * attribute: "wp1:" + base64url (RFC 4648 §5, no padding) of one byte per
 * peak, byte = round(clamp(peak, 0, 1) × 255).
 */

/** Deterministic pseudo-random peaks in 0..1. */
function peaksOf(n, seed = 1) {
	let s = seed;
	return Array.from({ length: n }, () => {
		s = (s * 16807) % 2147483647;
		return s / 2147483647;
	});
}

describe('encodeCompactPeaks', () => {
	it('encodes 1800 peaks as 2404 characters', () => {
		expect(encodeCompactPeaks(peaksOf(1800))).toHaveLength(2404);
	});

	it('uses the base64url alphabet with no padding', () => {
		for (const n of [0, 1, 2, 3, 4, 5, 1800]) {
			const s = encodeCompactPeaks(peaksOf(n, n + 7));
			expect(s.startsWith('wp1:')).toBe(true);
			expect(s.slice(4)).toMatch(/^[A-Za-z0-9_-]*$/);
			expect(s).toHaveLength(4 + Math.ceil((n * 4) / 3));
		}
		// 0xfb 0xff: standard base64 would be "+/8=".
		expect(encodeCompactPeaks([251 / 255, 1])).toBe('wp1:-_8');
	});

	it('maps each peak to round(peak × 255)', () => {
		expect(encodeCompactPeaks([0, 0.5, 1])).toBe('wp1:AID_');
		expect(encodeCompactPeaks([])).toBe(COMPACT_PEAKS_PREFIX);
		expect(COMPACT_PEAKS_PREFIX).toBe('wp1:');
	});

	it('clamps out-of-range values and counts non-numbers as 0', () => {
		expect(encodeCompactPeaks([-0.5, 1.7, 2, -Infinity, Infinity, Number.NaN, null]))
			.toBe(encodeCompactPeaks([0, 1, 1, 0, 0, 0, 0]));
		expect(decodeCompactPeaks(encodeCompactPeaks([-3, 3]))).toEqual([0, 1]);
	});

	it('throws on a non-array', () => {
		expect(() => encodeCompactPeaks('0.5')).toThrow(TypeError);
		expect(() => encodeCompactPeaks(null)).toThrow(/expects an array/);
	});
});

describe('decodeCompactPeaks', () => {
	it('round-trips to within 1/255 of the clamped input', () => {
		const input = [...peaksOf(1800), -1, 0, 1, 2, 0.001, 0.999];
		const out = decodeCompactPeaks(encodeCompactPeaks(input));
		expect(out).toHaveLength(input.length);
		out.forEach((v, i) => {
			const clamped = Math.min(Math.max(input[i], 0), 1);
			expect(Math.abs(v - clamped)).toBeLessThanOrEqual(1 / 255);
			expect(v).toBe(Math.round(v * 255) / 255);
		});
	});

	it('decodes every byte value exactly as byte / 255', () => {
		const bytes = Array.from({ length: 256 }, (_, b) => b / 255);
		expect(decodeCompactPeaks(encodeCompactPeaks(bytes))).toEqual(bytes);
	});

	it('decodes an empty string body to no peaks', () => {
		expect(decodeCompactPeaks('wp1:')).toEqual([]);
	});

	it('throws without the wp1: prefix', () => {
		expect(() => decodeCompactPeaks('AID_')).toThrow(/must start with "wp1:"/);
		expect(() => decodeCompactPeaks('wp2:AID_')).toThrow(/must start with "wp1:"/);
		expect(() => decodeCompactPeaks('WP1:AID_')).toThrow(/must start with "wp1:"/);
		expect(() => decodeCompactPeaks(null)).toThrow(/must start with "wp1:"/);
		expect(() => decodeCompactPeaks(['wp1:AID_'])).toThrow(/must start with "wp1:"/);
	});

	it('throws on characters outside base64url, padding included', () => {
		expect(() => decodeCompactPeaks('wp1:+/8')).toThrow(/invalid character "\+"/);
		expect(() => decodeCompactPeaks('wp1:AID=')).toThrow(/invalid character "="/);
		expect(() => decodeCompactPeaks('wp1:AI D_')).toThrow(/invalid character " "/);
		expect(() => decodeCompactPeaks('wp1:AID_\n')).toThrow(/invalid character/);
	});

	it('throws on a length no bytes encode to, or stray trailing bits', () => {
		// 5 characters: one too many for 3 bytes, too few for 4.
		expect(() => decodeCompactPeaks('wp1:AID_A')).toThrow(/not valid base64url/);
		// "AB" carries a set bit past the single byte it encodes.
		expect(() => decodeCompactPeaks('wp1:AB')).toThrow(/not valid base64url/);
		expect(decodeCompactPeaks('wp1:AA')).toEqual([0]);
	});
});
