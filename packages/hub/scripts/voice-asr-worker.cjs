const fs = require("node:fs");
const path = require("node:path");

try {
  const [operation, directory, audio] = process.argv.slice(2);
  if (!["--check", "--transcribe"].includes(operation) || !directory || operation === "--transcribe" && !audio) throw new Error("Invalid operation");
  const sherpa = require("sherpa-onnx-node");
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: path.join(directory, "model.int8.onnx"), language: "auto", useInverseTextNormalization: 1 },
      tokens: path.join(directory, "tokens.txt"), numThreads: 2, provider: "cpu", debug: 0,
    },
  });
  if (operation === "--check") {
    process.stdout.write(JSON.stringify({ ready: true }));
  } else {
    const bytes = fs.readFileSync(audio);
    if (!bytes.length || bytes.length % 4 !== 0 || bytes.length > 16000 * 4 * 20 * 60) throw new Error("Invalid audio");
    const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    const chunks = [];
    // SenseVoice's attention memory grows with sequence length. Prefer a quiet
    // boundary near 30 seconds instead of decoding an entire long recording.
    const maximum = 30 * 16000;
    let start = 0;
    while (start < samples.length) {
      let end = Math.min(samples.length, start + maximum);
      if (end < samples.length) {
        const boundary = end;
        let quietest = Infinity;
        const window = 1600;
        for (let candidate = boundary - 5 * 16000; candidate + window <= boundary; candidate += window) {
          let energy = 0;
          for (let index = candidate; index < candidate + window; index++) energy += samples[index] * samples[index];
          if (energy < quietest) { quietest = energy; end = candidate + window; }
        }
      }
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: samples.subarray(start, end) });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      if (result.text?.trim()) chunks.push(result.text.trim());
      start = end;
    }
    process.stdout.write(JSON.stringify({ text: chunks.join(" ") }));
  }
} catch {
  // The Hub reports a bounded public error; native logs and filesystem paths
  // must not become part of a user's message or a process protocol response.
  process.exitCode = 1;
}
