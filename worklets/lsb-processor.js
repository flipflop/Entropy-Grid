/**
 * LSBProcessor — AudioWorkletProcessor
 * Runs on the dedicated audio rendering thread.
 * Extracts the 2 least-significant bits from each float32 sample,
 * applies Von Neumann debiasing, and posts batches to the main thread.
 *
 * Von Neumann debiasing: consume pairs of bits (b0, b1).
 *   00 → discard  (correlated zero)
 *   11 → discard  (correlated one)
 *   01 → emit 0   (unbiased)
 *   10 → emit 1   (unbiased)
 * This removes any DC bias introduced by ADC non-linearity.
 */
class LSBProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer: 512 debiased bits per post
    this._buf = new Uint8Array(512);
    this._head = 0;
    // Von Neumann state: holds the previous raw bit for pairing
    this._vnPrev = -1;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    const view = new DataView(new ArrayBuffer(4));

    for (let i = 0; i < channel.length; i++) {
      view.setFloat32(0, channel[i], false);
      const raw = view.getUint32(0, false);

      // Extract 2 LSBs as two separate bits
      for (let bitPos = 1; bitPos >= 0; bitPos--) {
        const bit = (raw >> bitPos) & 1;

        if (this._vnPrev === -1) {
          this._vnPrev = bit;
        } else {
          const prev = this._vnPrev;
          this._vnPrev = -1;
          // Von Neumann: only emit on transitions
          if (prev !== bit) {
            this._buf[this._head++] = prev === 0 ? 0 : 1;

            if (this._head === this._buf.length) {
              // Transfer ownership of the buffer to avoid copy
              this.port.postMessage(this._buf.buffer, [this._buf.buffer]);
              this._buf = new Uint8Array(512);
              this._head = 0;
            }
          }
        }
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor('lsb-processor', LSBProcessor);
