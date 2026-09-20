// tap-worklet.js — records the master bus with the exact audio-clock frame of
// every 128-frame block. A ScriptProcessorNode double-buffers and reported
// ~12 ms of latency that was the tap's own, not the app's.
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const copy = new Float32Array(ch.length);
      copy.set(ch);
      this.port.postMessage({ frame: currentFrame, data: copy }, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('bmt-tap', Tap);
