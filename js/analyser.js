/**
 * Analyser — Algorithmic Randomness Diagnostics
 *
 * Maintains a circular buffer of recent digits and computes three
 * complementary randomness metrics on demand:
 *
 * 1. Lag-1 Autocorrelation (r₁)
 *    r₁ = c₁/c₀  where cₕ = (1/N) Σ (Yₜ - Ȳ)(Yₜ₊ₕ - Ȳ)
 *    For white noise: E[r₁] = 0, 95% confidence band = ±1.96/√N
 *    Detects: serial dependence between consecutive digits.
 *
 * 2. Chi-squared p-value (running)
 *    Sampled from the Heatmap instance at each snapshot.
 *    Detects: distributional bias across all 10 digits.
 *
 * 3. Wald-Wolfowitz Runs Test Z-score
 *    A "run" is a maximal sequence of values all above or all below
 *    the median (4.5 for digits 0–9). For n₁ values above and n₂ below:
 *      μ_R = 2n₁n₂/(n₁+n₂) + 1
 *      σ_R = √(2n₁n₂(2n₁n₂ - n₁ - n₂) / ((n₁+n₂)²(n₁+n₂-1)))
 *      Z   = (R - μ_R) / σ_R
 *    For white noise: E[Z] = 0, 95% band = ±1.96
 *    Detects: clustering or alternation patterns autocorrelation can miss.
 */
export class Analyser {
  static BUFFER_SIZE = 2000;
  static MIN_N       = 50;   // minimum samples before metrics are meaningful

  constructor(heatmap) {
    this._heatmap = heatmap;
    this._buf     = new Uint8Array(Analyser.BUFFER_SIZE);
    this._head    = 0;
    this._n       = 0;        // total recorded (capped at BUFFER_SIZE for calcs)
  }

  record(digit) {
    this._buf[this._head] = digit;
    this._head = (this._head + 1) % Analyser.BUFFER_SIZE;
    if (this._n < Analyser.BUFFER_SIZE) this._n++;
  }

  reset() {
    this._buf.fill(0);
    this._head = 0;
    this._n    = 0;
  }

  /**
   * Returns a snapshot of all three metrics.
   * Returns null if not enough data yet.
   */
  getSnapshot() {
    const n = this._n;
    if (n < Analyser.MIN_N) return null;

    const seq = this._getSequence(n);
    const r1  = this._autocorr(seq, 1);
    const band95 = 1.96 / Math.sqrt(n);

    const runsZ     = this._runsTest(seq);
    const runsBand  = 1.96;

    const pValue    = this._heatmap.pValue();

    return { n, r1, band95, runsZ, runsBand, pValue };
  }

  /** Extract the last n values from the circular buffer in order */
  _getSequence(n) {
    const seq = new Float64Array(n);
    const start = (this._head - n + Analyser.BUFFER_SIZE) % Analyser.BUFFER_SIZE;
    for (let i = 0; i < n; i++) {
      seq[i] = this._buf[(start + i) % Analyser.BUFFER_SIZE];
    }
    return seq;
  }

  /** Lag-h autocorrelation using the 1/N autocovariance formulation */
  _autocorr(seq, h) {
    const n    = seq.length;
    let   mean = 0;
    for (let i = 0; i < n; i++) mean += seq[i];
    mean /= n;

    let c0 = 0, ch = 0;
    for (let i = 0; i < n; i++)     c0 += (seq[i] - mean) ** 2;
    for (let i = 0; i < n - h; i++) ch += (seq[i] - mean) * (seq[i + h] - mean);

    c0 /= n;
    ch /= n;
    return c0 === 0 ? 0 : ch / c0;
  }

  /** Wald-Wolfowitz runs test Z-score. Median of digits 0–9 = 4.5 */
  _runsTest(seq) {
    const n  = seq.length;
    const MED = 4.5;
    let n1 = 0, n2 = 0, runs = 1;
    let prevAbove = seq[0] > MED;
    if (prevAbove) n1++; else n2++;

    for (let i = 1; i < n; i++) {
      const above = seq[i] > MED;
      if (above) n1++; else n2++;
      if (above !== prevAbove) { runs++; prevAbove = above; }
    }

    if (n1 === 0 || n2 === 0) return 0;

    const N   = n1 + n2;
    const mu  = (2 * n1 * n2) / N + 1;
    const sig = Math.sqrt(
      (2 * n1 * n2 * (2 * n1 * n2 - N)) / (N * N * (N - 1))
    );
    return sig === 0 ? 0 : (runs - mu) / sig;
  }
}
