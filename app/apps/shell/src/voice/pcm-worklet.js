// Audio worklet (spec 7.2 "Capture"): resamples microphone audio to 16 kHz, 16-bit linear PCM,
// mono, and posts 100 ms frames with their level. It runs on the audio thread; nothing is stored.
/* global sampleRate, registerProcessor, AudioWorkletProcessor */
const TARGET_RATE = 16000;
const FRAME = 1600; // 100 ms at 16 kHz

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.frame = new Int16Array(FRAME);
    this.filled = 0;
    this.pos = 0;
    this.acc = 0;
    this.count = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      // Averaging the input samples that fall into each output sample is a simple low-pass.
      this.acc += channel[i];
      this.count += 1;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.acc / this.count));
        this.acc = 0;
        this.count = 0;
        this.sumSq += s * s;
        this.frame[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.filled === FRAME) {
          const out = this.frame;
          this.port.postMessage({ pcm: out.buffer, level: Math.sqrt(this.sumSq / FRAME) }, [out.buffer]);
          this.frame = new Int16Array(FRAME);
          this.filled = 0;
          this.sumSq = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
