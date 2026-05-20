const TARGET_INPUT_RATE = 16000;
const PLAYBACK_RATE = 24000;
const CHUNK_FRAMES = 1600; // 100 ms at 16 kHz

const WORKLET_SOURCE = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.targetRate = ${TARGET_INPUT_RATE};
    this.chunkFrames = ${CHUNK_FRAMES};
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    const ratio = sampleRate / this.targetRate;
    // Naive decimation — adequate for voice; browser AEC + voice band keeps aliasing acceptable
    let i = 0;
    while (i < channel.length) {
      this.buffer.push(channel[Math.floor(i)]);
      i += ratio;
    }
    while (this.buffer.length >= this.chunkFrames) {
      const slice = this.buffer.splice(0, this.chunkFrames);
      const int16 = new Int16Array(slice.length);
      for (let j = 0; j < slice.length; j++) {
        const s = Math.max(-1, Math.min(1, slice[j]));
        int16[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToInt16Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export async function createAudioPipeline({ onMicChunk }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
  });

  const inputCtx = new AudioContext();
  const playbackCtx = new AudioContext({ sampleRate: PLAYBACK_RATE });

  const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
  const workletUrl = URL.createObjectURL(blob);
  await inputCtx.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  const source = inputCtx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(inputCtx, 'pcm-processor');

  worklet.port.onmessage = (e) => {
    onMicChunk(bufferToBase64(e.data));
  };

  source.connect(worklet);
  // worklet output is unused (we only consume via the message port)

  const activeSources = new Set();
  let nextPlaybackTime = 0;

  function playChunk(base64) {
    const int16 = base64ToInt16Array(base64);
    if (!int16.length) return;
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const audioBuffer = playbackCtx.createBuffer(1, float32.length, PLAYBACK_RATE);
    audioBuffer.copyToChannel(float32, 0);

    const src = playbackCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(playbackCtx.destination);

    const now = playbackCtx.currentTime;
    if (nextPlaybackTime < now) nextPlaybackTime = now;
    src.start(nextPlaybackTime);
    nextPlaybackTime += audioBuffer.duration;

    activeSources.add(src);
    src.onended = () => activeSources.delete(src);
  }

  function stopPlayback() {
    for (const src of activeSources) {
      try { src.stop(); } catch {}
    }
    activeSources.clear();
    nextPlaybackTime = playbackCtx.currentTime;
  }

  function stop() {
    stopPlayback();
    stream.getTracks().forEach(t => t.stop());
    try { source.disconnect(); } catch {}
    try { worklet.disconnect(); } catch {}
    try { inputCtx.close(); } catch {}
    try { playbackCtx.close(); } catch {}
  }

  return { playChunk, stopPlayback, stop };
}
