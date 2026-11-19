import { translate as t } from "../../kulo-i18n";

/** Keep the fractional source position across render quanta, including 44.1 kHz microphones. */
export class Pcm16Resampler {
  #pending = new Float32Array(0);
  #position = 0;
  readonly #ratio: number;
  constructor(inputRate: number, outputRate: number) {
    if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate) || inputRate <= 0 || outputRate <= 0) throw new Error(t("音频采样率无效", "Invalid audio sample rate"));
    this.#ratio = inputRate / outputRate;
  }
  push(input: Float32Array): Int16Array {
    const source = new Float32Array(this.#pending.length + input.length);
    source.set(this.#pending); source.set(input, this.#pending.length);
    const output: number[] = [];
    while (this.#position + 1 < source.length) {
      const index = Math.floor(this.#position);
      const fraction = this.#position - index;
      const value = Math.max(-1, Math.min(1, source[index]! * (1 - fraction) + source[index + 1]! * fraction));
      output.push(Math.round(value * (value < 0 ? 32768 : 32767)));
      this.#position += this.#ratio;
    }
    const consumed = Math.min(source.length, Math.floor(this.#position));
    this.#pending = source.slice(consumed);
    this.#position -= consumed;
    return Int16Array.from(output);
  }
}

export function pcm16Base64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) view.setInt16(index * 2, samples[index]!, true);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodePcm16(data: string): Float32Array {
  if (data.length > 2 * 1024 * 1024) throw new Error(t("通话音频片段过大", "Call audio chunk is too large"));
  const binary = atob(data);
  if (!binary.length || binary.length % 2) throw new Error(t("通话音频格式无效", "Invalid call audio format"));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(bytes.length / 2);
  for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}

export function rootMeanSquare(samples: Float32Array): number {
  if (!samples.length) return 0;
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / samples.length);
}

export class MicrophoneActivity {
  #speechMs = 0;
  #suppressUntil = 0;
  observe(samples: Float32Array, sampleRate: number, now: number): boolean {
    if (rootMeanSquare(samples) > 0.035) this.#speechMs += samples.length / sampleRate * 1000;
    else this.#speechMs = 0;
    if (this.#speechMs >= 100) this.#suppressUntil = now + 250;
    return this.isSpeaking(now);
  }
  isSpeaking(now: number): boolean { return now < this.#suppressUntil; }
  reset(): void { this.#speechMs = 0; this.#suppressUntil = 0; }
}

export class VoicePlayback {
  #nextTime = 0;
  #sources = new Set<AudioBufferSourceNode>();
  constructor(readonly context: AudioContext, readonly onActive: (active: boolean) => void) {}
  enqueue(data: string, sampleRate: number): void {
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error(t("通话音频采样率无效", "Invalid call audio sample rate"));
    const samples = decodePcm16(data);
    if (this.#nextTime - this.context.currentTime > 15) throw new Error(t("语音播放积压，请重新连接", "Audio playback is backed up. Reconnect to continue"));
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer; source.connect(this.context.destination);
    const wasSilent = this.#sources.size === 0;
    this.#sources.add(source);
    source.onended = () => { source.disconnect(); this.#sources.delete(source); if (!this.#sources.size) this.onActive(false); };
    const start = Math.max(this.context.currentTime + 0.015, this.#nextTime);
    this.#nextTime = start + buffer.duration;
    source.start(start); if (wasSilent) this.onActive(true);
  }
  interrupt(): void {
    for (const source of this.#sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.#sources.clear(); this.#nextTime = 0; this.onActive(false);
  }
}
