/**
 * EntropyPool — Observer pattern via EventTarget
 * Manages microphone acquisition, AudioWorklet lifecycle,
 * and a ring buffer of debiased entropy bits.
 *
 * Dispatches:
 *   'ready'  — pool has enough bits to start generating
 *   'update' — new bits have been added to the pool
 *   'error'  — mic access denied or API unsupported
 */
export class EntropyPool extends EventTarget {
  // Minimum bits before we declare the pool ready
  static MIN_BITS = 2048;
  // Ring buffer capacity: 65536 bits (~8KB)
  static CAPACITY = 65536;

  constructor() {
    super();
    this._ring = new Uint8Array(EntropyPool.CAPACITY);
    this._writeHead = 0;
    this._readHead = 0;
    this._totalBits = 0;
    this._ready = false;
    this._audioCtx = null;
    this._stream = null;
  }

  get availableBits() {
    return (this._writeHead - this._readHead + EntropyPool.CAPACITY) % EntropyPool.CAPACITY;
  }

  get isReady() {
    return this._ready;
  }

  /**
   * Start microphone capture and worklet pipeline.
   * Returns a promise that resolves when the mic is granted.
   */
  async start() {
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 48000,
        },
      });

      this._audioCtx = new AudioContext({ sampleRate: 48000 });

      // Worklet must be loaded from a URL — use a blob URL so we stay single-origin
      // without a server, while keeping the processor in its own file.
      await this._audioCtx.audioWorklet.addModule('./worklets/lsb-processor.js');

      const source = this._audioCtx.createMediaStreamSource(this._stream);
      const workletNode = new AudioWorkletNode(this._audioCtx, 'lsb-processor');

      workletNode.port.onmessage = (e) => this._ingest(new Uint8Array(e.data));

      // Connect source → worklet. Do NOT connect worklet to destination
      // (we don't want to play back mic audio).
      source.connect(workletNode);

    } catch (err) {
      this.dispatchEvent(Object.assign(new Event('error'), { detail: err }));
    }
  }

  /**
   * Read `count` bits from the ring buffer.
   * Returns null if not enough bits are available.
   */
  readBits(count) {
    if (this.availableBits < count) return null;
    const bits = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      bits[i] = this._ring[this._readHead];
      this._readHead = (this._readHead + 1) % EntropyPool.CAPACITY;
    }
    return bits;
  }

  stop() {
    this._stream?.getTracks().forEach(t => t.stop());
    if (this._audioCtx && this._audioCtx.state !== 'closed') {
      this._audioCtx.close();
    }
    this._audioCtx = null;
    this._stream   = null;
    this._ready    = false;
  }

  /** @private */
  _ingest(bits) {
    for (let i = 0; i < bits.length; i++) {
      this._ring[this._writeHead] = bits[i];
      this._writeHead = (this._writeHead + 1) % EntropyPool.CAPACITY;
      this._totalBits++;
    }

    if (!this._ready && this._totalBits >= EntropyPool.MIN_BITS) {
      this._ready = true;
      this.dispatchEvent(new Event('ready'));
    }

    this.dispatchEvent(new Event('update'));
  }
}
