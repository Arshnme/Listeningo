/**
 * WebM/Opus encoding for the offline audio cache.
 *
 * Why this exists: LibriSpeech ships 16 kHz mono FLAC at roughly 6.6 KB per word
 * (~45 KB for a three-word clip, ~190 KB for a thirty-word one). FLAC is already
 * lossless, so there is nothing left to squeeze out of it — but the *source* is
 * 16 kHz speech, which Opus was designed for. Encoding at 24 kbps mono is
 * transparent for speech and lands around 3 KB/second, which is 5-8x smaller
 * than the FLAC. That is what lets a tier be held offline several times over.
 *
 * This only affects what the browser *stores*. The download from the CDN is
 * always FLAC, because that is what the dataset serves and there is no server
 * here to transcode on. So: one FLAC download per clip ever, then a compact
 * local copy.
 *
 * Container choice is WebM rather than Ogg on purpose. Safari has never played
 * Ogg/Opus in a media element, but it has played WebM/Opus since Safari 14.1 on
 * macOS 11.3 and iOS 17.4. Anything that cannot both encode and play this falls
 * back to storing the FLAC untouched.
 */

const OPUS_BITRATE = 24_000;
const OPUS_SAMPLE_RATE = 48_000;
/** Opus granule positions count 48 kHz samples regardless of the input rate. */
const NANOSECONDS_PER_SECOND = 1_000_000_000;

interface AudioEncoderLike extends EventTarget {
  configure(config: AudioEncoderConfig): void;
  encode(data: AudioData): void;
  flush(): Promise<void>;
  close(): void;
  readonly encodeQueueSize: number;
}

type AudioEncoderCtor = new (init: { output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void; error: (error: DOMException) => void }) => AudioEncoderLike;

function audioEncoderCtor(): AudioEncoderCtor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as typeof window & { AudioEncoder?: AudioEncoderCtor };
  return scope.AudioEncoder ?? null;
}

let supportCache: boolean | null = null;

/**
 * True when this browser can both encode Opus and play it back.
 *
 * Both halves matter: encoding something the same browser cannot play would
 * corrupt the cache. The playability probe uses `canPlayType`, which is cheap
 * and synchronous.
 */
export function supportsOpusCache(): boolean {
  if (supportCache !== null) return supportCache;
  const Ctor = audioEncoderCtor();
  if (!Ctor) {
    supportCache = false;
    return false;
  }
  let playable = false;
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const probe = document.createElement('audio');
    playable =
      probe.canPlayType('audio/webm; codecs="opus"') !== '' ||
      probe.canPlayType('audio/webm;codecs=opus') !== '';
  }
  supportCache = playable;
  return supportCache;
}

/** Estimated bytes per second of Opus audio at the configured bitrate. */
export const OPUS_BYTES_PER_SECOND = OPUS_BITRATE / 8;

/* ----------------------------------------------------------------- WebM -- */

/** Writes an EBML element id and its size as a variable-length integer. */
function vint(value: number): number[] {
  // Element sizes up to 2^28 fit in four bytes, which is all this muxer needs.
  for (let length = 1; length <= 8; length += 1) {
    const max = 2 ** (7 * length) - 1;
    if (value < max) {
      const bytes = new Array<number>(length);
      let remaining = value;
      for (let i = length - 1; i >= 0; i -= 1) {
        bytes[i] = remaining & 0xff;
        remaining >>= 8;
      }
      bytes[0] = (bytes[0] ?? 0) | (1 << (8 - length));
      return bytes;
    }
  }
  return [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
}

function uint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return bytes;
}

function float64(value: number): number[] {
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value, false);
  return Array.from(new Uint8Array(buffer.buffer));
}

function element(id: readonly number[], payload: readonly number[]): number[] {
  return [...id, ...vint(payload.length), ...payload];
}

function textElement(id: readonly number[], value: string): number[] {
  return element(id, Array.from(new TextEncoder().encode(value)));
}

const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  EBMLVersion: [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xf7],
  EBMLMaxIDLength: [0x42, 0xf2],
  EBMLMaxSizeLength: [0x42, 0xf3],
  DocType: [0x42, 0x82],
  DocTypeVersion: [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimecodeScale: [0x2a, 0xd7, 0xb1],
  MuxingApp: [0x4d, 0x80],
  WritingApp: [0x57, 0x41],
  Duration: [0x44, 0x89],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackUID: [0x73, 0xc5],
  TrackType: [0x83],
  FlagLacing: [0x9c],
  CodecID: [0x86],
  CodecPrivate: [0x63, 0xa2],
  CodecDelay: [0x56, 0xaa],
  SeekPreRoll: [0x56, 0xbb],
  DefaultDuration: [0x23, 0xe3, 0x83],
  Audio: [0xe1],
  SamplingFrequency: [0xb5],
  Channels: [0x9f],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timecode: [0xe7],
  SimpleBlock: [0xa3],
} as const;

/** The 19-byte OpusHead that Opus in WebM requires as codec private data. */
function opusHead(channels: number, sampleRate: number, preSkip: number): number[] {
  const header = new Array<number>(19).fill(0);
  header[0] = 0x4f; // O
  header[1] = 0x70; // p
  header[2] = 0x75; // u
  header[3] = 0x73; // s
  header[4] = 0x48; // H
  header[5] = 0x65; // e
  header[6] = 0x61; // a
  header[7] = 0x64; // d
  header[8] = 1; // version
  header[9] = channels;
  header[10] = preSkip & 0xff;
  header[11] = (preSkip >> 8) & 0xff;
  header[12] = sampleRate & 0xff;
  header[13] = (sampleRate >> 8) & 0xff;
  header[14] = (sampleRate >> 16) & 0xff;
  header[15] = (sampleRate >> 24) & 0xff;
  header[16] = 0;
  header[17] = 0;
  header[18] = 0;
  return header;
}

interface OpusFrame {
  data: Uint8Array;
  /** Presentation time in nanoseconds. */
  timestamp: number;
  duration: number;
}

/** Assembles encoded Opus frames into a playable WebM file. */
function muxWebm(frames: readonly OpusFrame[], totalDurationSeconds: number): Blob {
  const header = element(ID.EBML, [
    ...element(ID.EBMLVersion, uint(1)),
    ...element(ID.EBMLReadVersion, uint(1)),
    ...element(ID.EBMLMaxIDLength, uint(4)),
    ...element(ID.EBMLMaxSizeLength, uint(8)),
    ...textElement(ID.DocType, 'webm'),
    ...element(ID.DocTypeVersion, uint(4)),
    ...element(ID.DocTypeReadVersion, uint(2)),
  ]);

  const info = element(ID.Info, [
    ...element(ID.TimecodeScale, uint(1_000_000)),
    ...textElement(ID.MuxingApp, 'adaptive-listening-lab'),
    ...textElement(ID.WritingApp, 'adaptive-listening-lab'),
    ...element(ID.Duration, float64(totalDurationSeconds * 1000)),
  ]);

  const preSkip = 312;
  const track = element(ID.Tracks, [
    ...element(ID.TrackEntry, [
      ...element(ID.TrackNumber, uint(1)),
      ...element(ID.TrackUID, uint(1)),
      ...element(ID.TrackType, uint(2)),
      ...element(ID.FlagLacing, uint(0)),
      ...textElement(ID.CodecID, 'A_OPUS'),
      ...element(ID.CodecPrivate, opusHead(1, OPUS_SAMPLE_RATE, preSkip)),
      ...element(ID.CodecDelay, uint(preSkip * 1_000_000)),
      ...element(ID.SeekPreRoll, uint(80_000_000)),
      ...element(ID.Audio, [
        ...element(ID.SamplingFrequency, float64(OPUS_SAMPLE_RATE)),
        ...element(ID.Channels, uint(1)),
      ]),
    ]),
  ]);

  // One cluster per second of audio: long enough to stay efficient, short enough
  // that seeking within a clip stays cheap.
  const clusters: number[] = [];
  const framesPerCluster = 50;
  for (let start = 0; start < frames.length; start += framesPerCluster) {
    const slice = frames.slice(start, start + framesPerCluster);
    const first = slice[0];
    if (!first) continue;
    const timecode = Math.floor(first.timestamp / 1_000_000);
    const blocks: number[] = [];
    for (const frame of slice) {
      // Track number as a vint, then a 16-bit signed relative timecode.
      const relative = Math.max(
        -32768,
        Math.min(32767, Math.floor(frame.timestamp / 1_000_000) - timecode),
      );
      blocks.push(
        ...element(ID.SimpleBlock, [
          0x81,
          (relative >> 8) & 0xff,
          relative & 0xff,
          0x80, // keyframe flag
          ...Array.from(frame.data),
        ]),
      );
    }
    clusters.push(...element(ID.Cluster, [...element(ID.Timecode, uint(timecode)), ...blocks]));
  }

  const segmentPayload = [...info, ...track, ...clusters];
  // The segment uses an unknown size so the whole file need not be buffered
  // twice just to write its length.
  const segment = [...ID.Segment, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...segmentPayload];

  return new Blob([new Uint8Array([...header, ...segment])], { type: 'audio/webm' });
}

/* -------------------------------------------------------------- encoding -- */

let encoderSupportCache: boolean | null = null;

/** Asks the browser whether it will actually accept this Opus configuration. */
export async function canEncodeOpus(): Promise<boolean> {
  if (encoderSupportCache !== null) return encoderSupportCache;
  if (!supportsOpusCache()) {
    encoderSupportCache = false;
    return false;
  }
  const Ctor = audioEncoderCtor();
  if (!Ctor) {
    encoderSupportCache = false;
    return false;
  }
  try {
    const scope = window as typeof window & {
      AudioEncoder?: { isConfigSupported?: (config: AudioEncoderConfig) => Promise<{ supported?: boolean }> };
    };
    const probe = scope.AudioEncoder?.isConfigSupported;
    if (typeof probe !== 'function') {
      encoderSupportCache = true;
      return true;
    }
    const result = await probe({
      codec: 'opus',
      sampleRate: OPUS_SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate: OPUS_BITRATE,
    });
    encoderSupportCache = result.supported !== false;
  } catch {
    encoderSupportCache = false;
  }
  return encoderSupportCache;
}

/**
 * Re-encodes a decoded buffer to WebM/Opus.
 *
 * Returns null when this browser cannot do it, so the caller can keep the
 * original FLAC rather than storing something unplayable.
 */
export async function encodeToOpusWebm(buffer: AudioBuffer): Promise<Blob | null> {
  if (!(await canEncodeOpus())) return null;
  const Ctor = audioEncoderCtor();
  if (!Ctor) return null;

  const channels = buffer.numberOfChannels;
  const frames: OpusFrame[] = [];
  let failure: unknown = null;

  let encoder: AudioEncoderLike;
  try {
    encoder = new Ctor({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        frames.push({
          data,
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? 0,
        });
      },
      error: (error) => {
        failure = error;
      },
    });
    encoder.configure({
      codec: 'opus',
      sampleRate: OPUS_SAMPLE_RATE,
      numberOfChannels: channels,
      bitrate: OPUS_BITRATE,
    });
  } catch {
    return null;
  }

  // Opus wants 20 ms frames at 48 kHz, and the encoder is fed in that shape so
  // packet boundaries stay predictable.
  const frameSamples = OPUS_SAMPLE_RATE / 50;
  const sourceRate = buffer.sampleRate;
  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c += 1) channelData.push(buffer.getChannelData(c));

  const totalOutFrames = Math.ceil((buffer.duration * OPUS_SAMPLE_RATE) / frameSamples);
  const planar = new Float32Array(frameSamples);

  for (let index = 0; index < totalOutFrames; index += 1) {
    const outStart = index * frameSamples;
    for (let i = 0; i < frameSamples; i += 1) {
      // Nearest-sample resampling from 16 kHz to 48 kHz. Ratios are exact
      // multiples here, so this is a clean interpolation, not an approximation.
      const sourceIndex = Math.floor(((outStart + i) / OPUS_SAMPLE_RATE) * sourceRate);
      const sample = channelData[0]?.[Math.min(sourceIndex, (channelData[0]?.length ?? 1) - 1)] ?? 0;
      planar[i] = sample;
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: OPUS_SAMPLE_RATE,
      numberOfFrames: frameSamples,
      numberOfChannels: channels,
      timestamp: Math.round((outStart / OPUS_SAMPLE_RATE) * NANOSECONDS_PER_SECOND),
      data: planar,
    });
    try {
      encoder.encode(audioData);
    } finally {
      audioData.close();
    }
    // Keep the encoder queue shallow; it would otherwise buffer the whole clip.
    while (encoder.encodeQueueSize > 8) {
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
  }

  try {
    await encoder.flush();
  } catch {
    return null;
  } finally {
    try {
      encoder.close();
    } catch {
      /* already closed */
    }
  }

  if (failure || frames.length === 0) return null;
  return muxWebm(frames, buffer.duration);
}
