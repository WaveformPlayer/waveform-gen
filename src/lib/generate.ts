/**
 * @module generate
 * @description Core waveform peak extraction and BPM detection from audio files
 */

import decode from 'audio-decode';
import {readFile} from 'node:fs/promises';
import {basename, extname} from 'node:path';

/** Options for {@link generatePeaks}. */
export interface GeneratePeaksOptions {
    /**
     * Number of peaks to generate (default 1800, matching the CLI default and
     * the player's live-decode resolution); must be a positive integer.
     */
    samples?: number;
    /** Decimal places for rounding (default 2); negative leaves peaks unrounded. */
    precision?: number;
    /** Also detect BPM (default false). */
    detectBPM?: boolean;
}

/** What {@link generatePeaks} resolves with. */
export interface PeaksResult {
    /** Normalised peaks, loudest exactly 1.0. */
    peaks: number[];
    /** Detected tempo, or null when not asked for or not found. */
    bpm: number | null;
    /** Decoded length in seconds (unrounded). */
    duration: number;
}

/** The AudioBuffer-shaped read interface the peak and BPM code expects. */
interface AudioBufferView {
    length: number;
    numberOfChannels: number;
    sampleRate: number;
    getChannelData: (c: number) => Float32Array;
}

/** audio-decode v3's result. */
interface DecodedAudio {
    channelData: Float32Array[];
    sampleRate: number;
}

/**
 * Extract normalized peak data from an audio file
 * @param filePath - Path to audio file (mp3, wav, flac, ogg)
 * @param options
 * @param [options.samples=1800] - Number of peaks to generate (matches
 *   the CLI default and the player's live-decode resolution); must be a
 *   positive integer
 * @param [options.precision=2] - Decimal places for rounding
 * @param [options.detectBPM=false] - Also detect BPM
 * @returns The peaks, the BPM (null unless detected) and `duration`, the
 *   decoded length in seconds (unrounded).
 * @throws On an invalid `samples`, or a file that can't be decoded.
 */
export async function generatePeaks(filePath: string, options: GeneratePeaksOptions = {}): Promise<PeaksResult> {
    // Same rule as the CLI's --samples: a positive integer (numeric strings
    // allowed). Unchecked, a negative count returned [] and 100.5 returned
    // 101 peaks, both without complaint.
    const samples = options.samples == null ? 1800 : Number(options.samples);
    if (!Number.isInteger(samples) || samples < 1) {
        throw new Error(`[WaveformGen] samples must be a positive integer, got: ${options.samples}`);
    }
    const precision = options.precision !== undefined ? options.precision : 2;

    // Read and decode
    const buffer = await readFile(filePath);
    let audioBuffer: AudioBufferView;
    try {
        audioBuffer = toAudioBufferView(await decode(buffer));
    } catch (err: any) {
        // audio-decode signals an undecodable input with a message like
        // "Missing decoder for <type> format", "Cannot detect audio format"
        // (v2), or "Unknown audio format" (v3) — turn the cryptic crash into
        // a clear, actionable message.
        if (/missing decoder|cannot detect audio format|unknown audio format/i.test(err.message)) {
            throw undecodableError(filePath);
        }
        throw err;
    }

    // Some junk (e.g. an ID3 tag followed by garbage) "decodes" to no
    // channels, which would otherwise come back as an empty peaks array.
    if (!audioBuffer || !audioBuffer.numberOfChannels || !audioBuffer.length) {
        throw undecodableError(filePath);
    }

    // Extract peaks
    const peaks = extractPeaks(audioBuffer, samples);
    const normalized = normalizePeaks(peaks);

    // Round
    const rounded = roundPeaks(normalized, precision);

    // BPM detection
    let bpm: number | null = null;
    if (options.detectBPM) {
        bpm = detectBPM(audioBuffer);
    }

    return { peaks: rounded, bpm, duration: audioBuffer.length / audioBuffer.sampleRate };
}

/**
 * Round peaks to `precision` decimal places; a negative precision returns
 * them unchanged (the CLI's documented "don't round").
 *
 * @param peaks
 * @param precision
 */
export function roundPeaks(peaks: number[], precision: number): number[] {
    if (!(precision >= 0)) return peaks;
    const f = Math.pow(10, precision);
    return peaks.map(p => Math.round(p * f) / f);
}

const SUPPORTED_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'ogg']);

// Extensions the CLI picks up but audio-decode can't read.
const UNSUPPORTED_EXTENSIONS = new Set(['m4a', 'aac']);

/**
 * Build the error for a file audio-decode couldn't read.
 *
 * m4a/aac get the convert-first hint. A supported extension means the file
 * itself is bad, so telling the user "supported formats are mp3…" about their
 * mp3 would only contradict itself.
 *
 * @param filePath - The file that failed to decode.
 */
function undecodableError(filePath: string): Error {
    const name = basename(filePath);
    const ext = extname(filePath).toLowerCase().replace('.', '') || 'unknown';
    if (UNSUPPORTED_EXTENSIONS.has(ext)) {
        return new Error(
            `[WaveformGen] Cannot decode "${name}" (${ext}). ` +
            `m4a/aac are not supported — convert first, e.g.: ` +
            `ffmpeg -i "${name}" "${basename(filePath, extname(filePath))}.wav"`
        );
    }
    if (SUPPORTED_EXTENSIONS.has(ext)) {
        return new Error(`[WaveformGen] Cannot decode "${name}" (${ext}): the file appears to be corrupt or unreadable.`);
    }
    return new Error(
        `[WaveformGen] Cannot decode "${name}" (${ext}). ` +
        `Supported formats are mp3, wav, flac, and ogg.`
    );
}

/**
 * Normalize whatever `audio-decode` returns into one read interface, so the
 * peak/BPM code stays decoder-version agnostic.
 *
 * - audio-decode v2 returned a Web Audio `AudioBuffer`
 *   (`getChannelData()` / `length` / `numberOfChannels` / `sampleRate`).
 * - v3 returns a plain object `{ channelData: Float32Array[], sampleRate }`.
 *
 * Both are mapped to the AudioBuffer-shaped accessor the rest of this module
 * already expects.
 *
 * @param decoded
 */
function toAudioBufferView(decoded: AudioBufferView | DecodedAudio): AudioBufferView {
    if (decoded && Array.isArray((decoded as DecodedAudio).channelData)) {
        const channelData = (decoded as DecodedAudio).channelData;
        return {
            length: channelData[0] ? channelData[0].length : 0,
            numberOfChannels: channelData.length,
            sampleRate: (decoded as DecodedAudio).sampleRate,
            getChannelData: (c: number) => channelData[c],
        };
    }
    // Already an AudioBuffer (or AudioBuffer-like); use as-is.
    return decoded as AudioBufferView;
}

/**
 * Extract peak amplitudes from an AudioBuffer
 * @param buffer
 * @param samples
 */
function extractPeaks(buffer: AudioBufferView, samples: number): number[] {
    const sampleSize = buffer.length / samples;
    const channels = buffer.numberOfChannels;
    const peaks: number[] = [];

    for (let c = 0; c < channels; c++) {
        const chan = buffer.getChannelData(c);
        for (let i = 0; i < samples; i++) {
            const start = ~~(i * sampleSize);
            const end = ~~(start + sampleSize);
            let min = 0;
            let max = 0;

            // Scan every frame. The live player skips ~9/10 frames
            // (sampleStep = sampleSize/10) for real-time speed, but offline
            // we want accurate peaks and must not miss transients.
            for (let j = start; j < end; j++) {
                const value = chan[j];
                if (value > max) max = value;
                if (value < min) min = value;
            }

            const peak = Math.max(Math.abs(max), Math.abs(min));
            if (c === 0 || peak > peaks[i]) {
                peaks[i] = peak;
            }
        }
    }

    return peaks;
}

/**
 * Normalize peaks so the loudest peak is exactly 1.0.
 *
 * Mirrors the core player's extractPeaks normalization
 * (waveform-player/src/js/audio.js) — divide by the max — so pre-generated
 * JSON renders at identical amplitude to a live, in-browser decode. (Previously
 * this scaled to a 0.95 ceiling, making the same file render ~5% shorter.)
 * @param peaks
 */
function normalizePeaks(peaks: number[]): number[] {
    const maxPeak = peaks.reduce((m, v) => (v > m ? v : m), -Infinity);
    return maxPeak > 0 ? peaks.map(p => p / maxPeak) : peaks;
}

/**
 * Detect BPM from AudioBuffer
 * Ported from WaveformPlayer's bpm.js
 * @param buffer
 */
function detectBPM(buffer: AudioBufferView): number | null {
    try {
        const channelData = buffer.getChannelData(0);
        const sampleRate = buffer.sampleRate;

        // Detect onsets (transients/beats)
        const windowSize = 2048;
        const hopSize = windowSize / 2;
        const onsets: number[] = [];
        let previousEnergy = 0;

        for (let i = 0; i < channelData.length - windowSize; i += hopSize) {
            let energy = 0;
            for (let j = i; j < i + windowSize; j++) {
                energy += channelData[j] * channelData[j];
            }
            energy = energy / windowSize;

            const energyDiff = energy - previousEnergy;
            const threshold = previousEnergy * 1.8 + 0.01;

            if (energyDiff > threshold && energy > 0.01) {
                const lastOnset = onsets[onsets.length - 1] || 0;
                const minDistance = sampleRate * 0.15;

                if (i - lastOnset > minDistance) {
                    onsets.push(i);
                }
            }

            previousEnergy = energy * 0.8 + previousEnergy * 0.2;
        }

        if (onsets.length < 2) return null;

        // Calculate intervals and convert to tempos
        const tempoGroups: Record<number, number> = {};
        for (let i = 1; i < onsets.length; i++) {
            const interval = (onsets[i] - onsets[i - 1]) / sampleRate;
            const tempo = 60 / interval;
            const bucket = Math.round(tempo / 3) * 3;
            if (bucket > 60 && bucket < 200) {
                tempoGroups[bucket] = (tempoGroups[bucket] || 0) + 1;
            }
        }

        // Find most common tempo
        let maxCount = 0;
        let detectedBPM: number | null = null;
        for (const [tempo, count] of Object.entries(tempoGroups)) {
            if (count > maxCount) {
                maxCount = count;
                detectedBPM = parseInt(tempo);
            }
        }

        if (!detectedBPM) return null;

        // Handle tempo ambiguity
        if (detectedBPM < 70 && tempoGroups[detectedBPM * 2]) {
            detectedBPM *= 2;
        } else if (detectedBPM > 160 && tempoGroups[Math.round(detectedBPM / 2)]) {
            detectedBPM = Math.round(detectedBPM / 2);
        }

        return detectedBPM - 1; // Calibration offset
    } catch (e) {
        return null;
    }
}