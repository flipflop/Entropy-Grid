/**
 * Heatmap — Statistical colour scoring
 *
 * For each digit value (0–9), we maintain a global frequency count.
 * Each cell is coloured by the Z-score of its digit's observed frequency
 * relative to the expected uniform distribution.
 *
 * Z-score: z = (O - E) / sqrt(E)
 *   where O = observed count for this digit
 *         E = total samples / 10  (expected under H0: uniform)
 *
 * Colour scale (perceptual, OKLCH-inspired, mapped to hex):
 *   z ≤ -2.5  →  #1a6cf5  (deep blue:  significantly under-represented)
 *   z = -1    →  #4fc3f7  (light blue: mildly under-represented)
 *   z =  0    →  #1e2535  (dark slate: perfectly random / neutral)
 *   z = +1    →  #f5a623  (amber:      mildly over-represented)
 *   z ≥ +2.5  →  #e53935  (red:        significantly over-represented)
 *
 * A z-score beyond ±1.96 has p < 0.05 under a normal approximation,
 * so red/blue cells are statistically significant deviations.
 */
export class Heatmap {
  constructor() {
    // Frequency counts per digit 0–9
    this._counts = new Float64Array(10);
    this._total = 0;

    // Colour stops: [z_value, [r, g, b]]
    this._stops = [
      [-2.5, [26,  108, 245]],
      [-1.0, [79,  195, 247]],
      [ 0.0, [30,   37,  53]],
      [ 1.0, [245, 166,  35]],
      [ 2.5, [229,  57,  53]],
    ];
  }

  /** Record a new digit observation */
  record(digit) {
    this._counts[digit]++;
    this._total++;
  }

  /** Reset all counts */
  reset() {
    this._counts.fill(0);
    this._total = 0;
  }

  /**
   * Returns a CSS hex colour string for a given digit
   * based on its current Z-score.
   */
  colourFor(digit) {
    const z = this._zScore(digit);
    return this._interpolateColour(z);
  }

  /**
   * Returns the Z-score for a digit.
   * Returns 0 if not enough data yet.
   */
  _zScore(digit) {
    if (this._total < 10) return 0;
    const expected = this._total / 10;
    const observed = this._counts[digit];
    return (observed - expected) / Math.sqrt(expected);
  }

  /**
   * Linear interpolation across colour stops.
   * Clamps to the outermost stops.
   */
  _interpolateColour(z) {
    const stops = this._stops;

    if (z <= stops[0][0]) return this._toHex(stops[0][1]);
    if (z >= stops[stops.length - 1][0]) return this._toHex(stops[stops.length - 1][1]);

    for (let i = 0; i < stops.length - 1; i++) {
      const [z0, c0] = stops[i];
      const [z1, c1] = stops[i + 1];
      if (z >= z0 && z <= z1) {
        const t = (z - z0) / (z1 - z0);
        const r = Math.round(c0[0] + t * (c1[0] - c0[0]));
        const g = Math.round(c0[1] + t * (c1[1] - c0[1]));
        const b = Math.round(c0[2] + t * (c1[2] - c0[2]));
        return this._toHex([r, g, b]);
      }
    }

    return this._toHex(stops[2][1]); // neutral fallback
  }

  _toHex([r, g, b]) {
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
  }

  /** Returns current frequency stats for the histogram */
  getStats() {
    const expected = this._total > 0 ? this._total / 10 : 0;
    return Array.from({ length: 10 }, (_, i) => ({
      digit: i,
      count: this._counts[i],
      expected,
      z: this._zScore(i),
    }));
  }

  /** Overall chi-squared statistic across all digits */
  chiSquared() {
    if (this._total < 10) return 0;
    const expected = this._total / 10;
    let chi2 = 0;
    for (let i = 0; i < 10; i++) {
      const diff = this._counts[i] - expected;
      chi2 += (diff * diff) / expected;
    }
    return chi2;
  }

  /**
   * p-value approximation for chi-squared with 9 degrees of freedom.
   * Uses Wilson-Hilferty cube-root normal approximation.
   * Returns a value in [0, 1]; values > 0.05 suggest the distribution
   * is consistent with uniform randomness.
   */
  pValue() {
    const chi2 = this.chiSquared();
    const df = 9;
    // Wilson-Hilferty approximation: chi2 ~ N(df, 2*df) via cube root transform
    const z = (Math.pow(chi2 / df, 1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
    // Complementary CDF of standard normal (approximation)
    return 1 - this._normalCDF(z);
  }

  /** Abramowitz & Stegun approximation for Φ(z) */
  _normalCDF(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    const cdf = 1 - pdf * poly;
    return z >= 0 ? cdf : 1 - cdf;
  }
}
