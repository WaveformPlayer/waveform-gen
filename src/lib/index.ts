export {generatePeaks, roundPeaks} from './generate.js';
export type {GeneratePeaksOptions, PeaksResult} from './generate.js';
export {encodeCompactPeaks, decodeCompactPeaks, COMPACT_PEAKS_PREFIX} from './compact.js';
export {
    buildManifest,
    manifestEntry,
    isLoopPath,
    createManifest,
    parseFilename,
    encodePeaks,
    resamplePeaks,
    fileUrl,
    naturalCompare,
    commonRoot,
    relativeTo,
    MANIFEST_VERSION,
    DEFAULT_MANIFEST_BARS,
} from './manifest.js';
export type {
    BuildManifestOptions,
    ManifestAnalysis,
    ManifestEntry,
    ManifestEntryOptions,
    ManifestItem,
    ParsedFilename,
    RootInput,
    SoundsManifest,
} from './manifest.js';
