class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.left = new Float32Array(this.bufferSize);
    this.right = new Float32Array(this.bufferSize);
    this.offset = 0;

    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.flush();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  flush() {
    if (this.offset === 0) return;
    const left = this.left.slice(0, this.offset);
    const right = this.right.slice(0, this.offset);
    this.port.postMessage({ type: "pcm", left, right }, [left.buffer, right.buffer]);
    this.left = new Float32Array(this.bufferSize);
    this.right = new Float32Array(this.bufferSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input?.[0]?.length) return true;

    const leftInput = input[0];
    const rightInput = input[1] || leftInput;
    let inputOffset = 0;

    while (inputOffset < leftInput.length) {
      const count = Math.min(this.bufferSize - this.offset, leftInput.length - inputOffset);
      this.left.set(leftInput.subarray(inputOffset, inputOffset + count), this.offset);
      this.right.set(rightInput.subarray(inputOffset, inputOffset + count), this.offset);
      this.offset += count;
      inputOffset += count;

      if (this.offset === this.bufferSize) {
        this.flush();
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
