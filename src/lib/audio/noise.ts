import { NOMINAL_SPEECH_RMS } from '../levels';

/**
 * Noise synthesis and level metering for the acoustic simulation.
 *
 * The SNR target is honoured *measurably* rather than approximately: the voice's
 * speech-active RMS is estimated from the decoded samples, the generated noise
 * buffer's own RMS is measured, and the noise gain is solved so that
 *
 *     achieved SNR = 20 * log10(voiceRms / noiseRms) = requested SNR
 *
 * which keeps a "16 dB" tier genuinely 16 dB regardless of how loud the
 * particular LibriSpeech speaker happens to be.
 */

/** Frame size for level metering, in seconds (20 ms is the audio-engineering norm). */
const FRAME_SECONDS = 0.02;

/** Length of the generated, looped noise beds. */
const NOISE_SECONDS = 4;

/** RMS of a Float32 signal. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Estimates the *speech-active* RMS of a clip.
 *
 * A plain RMS over the whole file is dragged down by the silences between words,
 * which would make the injected noise too quiet. Instead this takes 20 ms frames,
 * discards the quiet ones, and returns the median of the active frames — a
 * standard robust speech-level estimate.
 */
export function estimateSpeechRms(buffer: AudioBuffer): number {
  const frameSize = Math.max(64, Math.floor(buffer.sampleRate * FRAME_SECONDS));
  const levels: number[] = [];

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let start = 0; start + frameSize <= data.length; start += frameSize) {
      levels.push(rmsOf(data.subarray(start, start + frameSize)));
    }
  }
  if (levels.length === 0) return NOMINAL_SPEECH_RMS;

  levels.sort((a, b) => a - b);
  const peak = levels[levels.length - 1] ?? 0;
  if (peak <= 0) return NOMINAL_SPEECH_RMS;
  const gate = peak * 0.2;
  const active = levels.filter((level) => level >= gate);
  const considered = active.length > 0 ? active : levels;
  const median = considered[Math.floor(considered.length / 2)] ?? NOMINAL_SPEECH_RMS;
  return Math.max(median, 1e-4);
}

/** Converts a dB signal-to-noise ratio into a linear amplitude ratio. */
export function snrToRatio(snrDb: number): number {
  return 10 ** (snrDb / 20);
}

/** Converts a linear amplitude ratio into dB. */
export function ratioToSnrDb(ratio: number): number {
  const safe = Math.max(ratio, 1e-6);
  return 20 * Math.log10(safe);
}

/**
 * Solves for the gain that places the noise bed at the requested SNR against a
 * voice whose speech-active RMS is `voiceRms`.
 *
 * `noiseRms` is the *measured* RMS of the generated bed, so the result is
 * independent of the generator's own output level.
 */
export function solveNoiseGain(voiceRms: number, noiseRms: number, snrDb: number): number {
  if (noiseRms <= 0) return 0;
  const target = voiceRms / snrToRatio(snrDb);
  return Math.max(0, target / noiseRms);
}

/** Foam-like white noise. */
function fillWhite(output: Float32Array, random: () => number): void {
  for (let i = 0; i < output.length; i += 1) {
    output[i] = random() * 2 - 1;
  }
}

/**
 * Pink noise via Paul Kellet's refined economy filter (-3 dB/octave).
 *
 * Implemented directly on the sample buffer so the bed loops seamlessly and
 * needs no filter nodes at playback time.
 */
function fillPink(output: Float32Array, random: () => number): void {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;

  for (let i = 0; i < output.length; i += 1) {
    const white = random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
}

/** Brown noise (-6 dB/octave), used for low room rumble. */
function fillBrown(output: Float32Array, random: () => number): void {
  let last = 0;
  for (let i = 0; i < output.length; i += 1) {
    const white = random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    output[i] = last * 3.5;
  }
}

/**
 * Crowd murmur: pink noise shaped by several slow, mutually detuned amplitude
 * envelopes so the bed swells and recedes like an indistinct room of voices.
 */
function fillCrowd(output: Float32Array, sampleRate: number, random: () => number): void {
  const scratch = new Float32Array(output.length);
  fillPink(scratch, random);

  const lfos = [
    { rate: 0.07 + random() * 0.05, phase: random() * Math.PI * 2, depth: 0.28 },
    { rate: 0.19 + random() * 0.1, phase: random() * Math.PI * 2, depth: 0.18 },
    { rate: 0.43 + random() * 0.2, phase: random() * Math.PI * 2, depth: 0.1 },
  ];

  for (let i = 0; i < output.length; i += 1) {
    const t = i / sampleRate;
    let envelope = 0.7;
    for (const lfo of lfos) {
      envelope += Math.sin(2 * Math.PI * lfo.rate * t + lfo.phase) * lfo.depth;
    }
    output[i] = (scratch[i] ?? 0) * Math.max(0.15, envelope);
  }
}

export type NoiseBed = 'white' | 'pink' | 'crowd' | 'brown';

/** Builds a stereo, seamlessly loopable noise bed of {@link NOISE_SECONDS}. */
export function createNoiseBuffer(context: BaseAudioContext, bed: NoiseBed, random = Math.random): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * NOISE_SECONDS));
  const buffer = context.createBuffer(2, length, context.sampleRate);
  // Decorrelated channels give the bed a natural width rather than a centred hiss.
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    if (bed === 'white') fillWhite(data, random);
    else if (bed === 'pink') fillPink(data, random);
    else if (bed === 'brown') fillBrown(data, random);
    else fillCrowd(data, buffer.sampleRate, random);
  }
  return buffer;
}

/** Measured RMS across every channel of a buffer. */
export function bufferRms(buffer: AudioBuffer): number {
  let sum = 0;
  let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const value = data[i] ?? 0;
      sum += value * value;
      count += 1;
    }
  }
  if (count === 0) return 0;
  return Math.sqrt(sum / count);
}
