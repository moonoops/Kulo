class KuloVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(1024);
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const length = channels[0].length;
    for (let index = 0; index < length; index++) {
      let value = 0;
      for (const channel of channels) value += channel[index] ?? 0;
      this.frame[this.offset++] = value / channels.length;
      if (this.offset === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(1024); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("kulo-voice-capture", KuloVoiceCapture);
