/**
 * RNG — Facade pattern
 * Wraps EntropyPool + SubtleCrypto into a single `nextDigit()` call.
 *
 * Algorithm:
 *   1. Read 256 raw bits from the entropy pool
 *   2. Hash with SHA-256 → 32 bytes of whitened output
 *   3. Rejection sampling over the hash bytes:
 *      For each byte b (0–255): if b < 250, emit (b % 10), else discard.
 *      250 is the largest multiple of 10 ≤ 255, so P(digit=k) = 25/250 = 1/10 exactly.
 *   4. Return digits from the rejection-sampled output queue.
 *
 * This avoids modulo bias: naive (b % 10) over [0,255] gives digits 0–5
 * a probability of 26/256 vs 25/256 for 6–9 — a measurable skew.
 */
export class RNG {
  // Bits consumed per hash call
  static BITS_PER_HASH = 256;

  constructor(entropyPool) {
    this._pool = entropyPool;
    // Pre-computed digit queue from each hash round
    this._digitQueue = [];
  }

  /**
   * Returns a single digit 0–9, or null if the pool is not ready.
   * Async because SHA-256 via SubtleCrypto is promise-based.
   */
  async nextDigit() {
    if (this._digitQueue.length > 0) {
      return this._digitQueue.shift();
    }

    const bits = this._pool.readBits(RNG.BITS_PER_HASH);
    if (!bits) return null;

    const hashBytes = await this._hash(bits);

    // Rejection sampling
    for (const byte of hashBytes) {
      if (byte < 250) {
        this._digitQueue.push(byte % 10);
      }
    }

    return this._digitQueue.length > 0 ? this._digitQueue.shift() : null;
  }

  /** @private — SHA-256 via SubtleCrypto (Strategy: swappable) */
  async _hash(bits) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', bits.buffer);
    return new Uint8Array(hashBuffer);
  }
}
