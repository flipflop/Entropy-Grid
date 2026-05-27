# Entropy Grid — a genuine random number generator to replace psuedo random number generators

A real-time random number generator and visualiser that harvests genuine entropy from microphone thermal noise, processes it through a cryptographic pipeline, and renders the output as a live heatmap grid with statistical diagnostics and a live randomness trend analysis chart.

---

## Goals

- Demonstrate that **true randomness** can be sourced from physical hardware noise rather than pseudo-random algorithms
- Provide a **statistically rigorous** pipeline: Von Neumann debiasing → SHA-256 whitening → rejection sampling
- Visualise the **distribution quality** of the output in real time using chi-squared analysis and a perceptual Z-score heatmap
- Run **three independent randomness tests** simultaneously — autocorrelation, runs test, and chi-squared — plotted as a live trend chart
- Support **configurable grid sizes** (20×20, 50×50, 100×100) for different levels of visual density
- Apply **software engineering best practices**: ES Modules, design patterns, separation of concerns, zero external dependencies

---

## Why Microphone Thermal Noise?

Laptop microphones cannot detect ultrasound (hardware filters cut off above ~18 kHz). More importantly, environmental ultrasound from motion sensors and chargers is *structured and repetitive* — the opposite of random.

The correct entropy source is **broadband thermal (Johnson) noise** in the audible range:

- The microscopic, chaotic movement of electrons inside the microphone's pre-amplifier creates a constant, physically unpredictable background hiss
- When digitised, the **least-significant bits** of each audio sample contain pure quantisation noise — values that are mathematically uncorrelated from one sample to the next
- This is the same principle used in hardware security modules (HSMs) and true random number generator (TRNG) chips

---

## Architecture

The project follows a strict **separation of concerns** with each file owning a single responsibility.

```
/
├── index.html                  # App shell, layout, ES module wiring
├── css/
│   └── styles.css              # Dark theme, typography, responsive layout
├── js/
│   ├── entropy-pool.js         # Mic acquisition, ring buffer, Observer pattern
│   ├── rng.js                  # SHA-256 whitening + rejection sampling (Facade)
│   ├── heatmap.js              # Z-score scoring, chi-squared, colour mapping
│   ├── grid.js                 # N×N DOM grid, rAF loop, histogram
│   ├── analyser.js             # Autocorrelation, runs test, snapshot computation
│   └── trend-chart.js          # SVG multi-series trend chart renderer
└── worklets/
    └── lsb-processor.js        # AudioWorkletProcessor (audio thread)
```

### Design Patterns

| Pattern | Where used | Why |
|---|---|---|
| **Observer / EventTarget** | `EntropyPool` dispatches `ready`, `update`, `error` | Decouples the audio pipeline from the UI; consumers subscribe without polling |
| **Facade** | `RNG.nextDigit()` | Hides the complexity of pool reads, async hashing, and the digit queue behind a single call |
| **Strategy** | `RNG._hash()` | The hash function is an isolated private method, swappable without changing the public API |
| **Object Pool / Ring Buffer** | `EntropyPool._ring` | Pre-allocated `Uint8Array` avoids GC pressure on the audio thread boundary |
| **Module Pattern** | All JS files as ES Modules | Explicit imports/exports, no global namespace pollution |
| **Session ID Guard** | `sessionId` counter in `index.html` | Prevents stale async callbacks from a previous session overwriting UI state after Stop is pressed |

---

## The Pipeline in Detail

### Step 1 — Capture (`worklets/lsb-processor.js`)

The `AudioWorkletProcessor` runs on the browser's dedicated **audio rendering thread**, isolated from the main thread to prevent UI jank from affecting sample timing.

Audio is requested with all processing disabled:

```js
navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: 48000,
  }
})
```

Disabling these is critical. Echo cancellation and noise suppression are DSP algorithms that *remove* the very noise we want to harvest.

### Step 2 — LSB Extraction (`worklets/lsb-processor.js`)

Each audio sample arrives as an IEEE 754 32-bit float. Its binary memory representation is read directly via `DataView`:

```js
view.setFloat32(0, sample, false);
const raw = view.getUint32(0, false);
const bit = (raw >> bitPos) & 1;  // extract bit 0 or bit 1
```

The 2 least-significant bits of the mantissa are where quantisation noise lives. These bits are not part of the meaningful audio signal — they are dominated by ADC rounding error and thermal noise.

### Step 3 — Von Neumann Debiasing (`worklets/lsb-processor.js`)

Raw ADC bits are not perfectly fair. A DC offset in the analogue circuit can make `0` slightly more probable than `1` (or vice versa). Von Neumann debiasing removes this bias without any knowledge of the bias magnitude:

```
Consume bits in pairs (b₀, b₁):
  00  →  discard  (both zero: correlated)
  11  →  discard  (both one: correlated)
  01  →  emit 0   (transition: unbiased)
  10  →  emit 1   (transition: unbiased)
```

**Proof of unbiasedness:** Let P(bit=1) = p (unknown, possibly ≠ 0.5).

- P(01) = (1−p)·p
- P(10) = p·(1−p)

These are equal regardless of p, so the emitted bits are exactly fair. The cost is throughput: on average, half the raw bits are discarded.

At 48 kHz with 2 LSBs per sample, the raw bit rate is ~96 kbps. After debiasing, the expected yield is ~48 kbps of unbiased entropy bits.

### Step 4 — Entropy Pool & Ring Buffer (`js/entropy-pool.js`)

Debiased bits are posted from the audio thread to the main thread in 512-bit batches using `MessagePort` with **transferable ownership** (`postMessage(buffer, [buffer])`), avoiding a memory copy.

The main thread stores bits in a **65,536-bit ring buffer** (`Uint8Array`). The pool dispatches:

- `ready` — once 2,048 bits have accumulated (enough for ~8 SHA-256 hash rounds)
- `update` — on every batch arrival, used to drive the seeding progress bar

### Step 5 — SHA-256 Whitening (`js/rng.js`)

Even after Von Neumann debiasing, subtle correlations may remain (e.g. from microphone resonance or ADC non-linearity at higher bit positions). SHA-256 **whitening** destroys all residual structure:

```js
const hashBuffer = await crypto.subtle.digest('SHA-256', bits.buffer);
```

256 raw bits in → 256 bits of cryptographically uniform output. The avalanche effect of SHA-256 means a single bit change in the input flips ~50% of output bits unpredictably.

### Step 6 — Rejection Sampling (`js/rng.js`)

Mapping a uniform byte (0–255) to a digit (0–9) via naive modulo introduces **modulo bias**:

```
256 / 10 = 25 remainder 6
→ digits 0–5 each have probability 26/256 ≈ 10.16%
→ digits 6–9 each have probability 25/256 ≈ 9.77%
```

This 0.4% skew is measurable and would show up in the chi-squared test. Rejection sampling eliminates it:

```js
// 250 is the largest multiple of 10 that fits in a byte (10 × 25 = 250)
if (byte < 250) {
  digit = byte % 10;  // P(digit = k) = 25/250 = 1/10 exactly
} else {
  discard;            // bytes 250–255 are rejected (~2.3% of bytes)
}
```

Each accepted digit has exactly P = 1/10 probability. The expected waste is only 6/256 ≈ 2.3% of hash bytes.

---

## Statistical Diagnostics

### Z-Score Heatmap

Each cell in the grid is coloured by the **Z-score** of its digit's observed frequency relative to the expected uniform distribution:

```
z = (O − E) / √E

where:
  O = observed count for this digit
  E = n / 10  (expected count under H₀: uniform distribution)
```

The Z-score follows an approximately standard normal distribution for large n. The colour scale maps:

| Z-score | Colour | Interpretation |
|---|---|---|
| ≤ −2.5 | Deep blue `#1a6cf5` | Significantly under-represented |
| −1.0 | Light cyan `#4fc3f7` | Mildly under-represented |
| 0.0 | Dark slate `#1e2535` | Perfectly uniform (neutral) |
| +1.0 | Amber `#f5a623` | Mildly over-represented |
| ≥ +2.5 | Red `#e53935` | Significantly over-represented |

At |z| > 1.96, the deviation is significant at p < 0.05. A healthy RNG should show a near-uniform grey field with occasional transient colour flickers.

### Chi-Squared Goodness-of-Fit

The overall distribution quality is measured with Pearson's chi-squared test:

```
χ² = Σᵢ (Oᵢ − E)² / E    for i = 0, 1, …, 9
```

With 10 categories and no estimated parameters, degrees of freedom = 9.

The p-value is computed using the **Wilson-Hilferty cube-root normal approximation** to the chi-squared CDF, avoiding the need for an incomplete gamma function:

```
z_wh = [ (χ²/df)^(1/3) − (1 − 2/(9·df)) ] / √(2/(9·df))
p = 1 − Φ(z_wh)
```

where Φ is the standard normal CDF (approximated via Abramowitz & Stegun polynomial).

**Interpreting the p-value:**

- `p > 0.05` — distribution is statistically consistent with uniform randomness ✓
- `p < 0.05` — statistically significant deviation detected ✗
- `p < 0.001` — strong evidence of non-randomness ✗✗

### Randomness Trend Analysis (`js/analyser.js` + `js/trend-chart.js`)

A live SVG chart below the grid plots three independent randomness metrics over time. Each catches a different kind of non-randomness, so together they provide a much more complete picture than any single test.

#### 1 — Lag-1 Autocorrelation (cyan line)

```
r₁ = c₁ / c₀

where  cₕ = (1/N) Σₜ (Yₜ − Ȳ)(Yₜ₊ₕ − Ȳ)
       c₀ = (1/N) Σₜ (Yₜ − Ȳ)²
```

Measures whether each digit is correlated with the one immediately before it. For a truly random sequence, r₁ ≈ 0. The 95% confidence band is ±1.96/√N (Bartlett's formula for white noise), which narrows as N grows.

**Detects:** serial dependence — e.g. a source that tends to repeat the same digit.

#### 2 — Wald-Wolfowitz Runs Test (amber line)

A "run" is a maximal consecutive sequence of values all above or all below the median (4.5 for digits 0–9). For n₁ values above and n₂ below:

```
μ_R = 2n₁n₂ / (n₁ + n₂) + 1
σ_R = √( 2n₁n₂(2n₁n₂ − n₁ − n₂) / ((n₁+n₂)²(n₁+n₂−1)) )
Z   = (R − μ_R) / σ_R
```

For white noise, Z ≈ 0 with 95% band ±1.96.

**Detects:** clustering (too few runs, Z ≪ 0) or alternation (too many runs, Z ≫ 0) — patterns that autocorrelation can miss.

#### 3 — Chi-Squared p-value (blue line)

The running p-value from the existing chi-squared test, sampled over time. Should remain above 0.05. Plotted on a separate right-hand axis (0–1).

**Detects:** distributional bias — one or more digits appearing significantly more or less often than 10%.

#### Reading the chart

| What you see | What it means |
|---|---|
| All lines within the shaded bands | Strong evidence of genuine randomness |
| Cyan or amber persistently outside ±1.96 | Serial dependence or clustering detected |
| Blue line below 0.05 | Distributional bias detected |
| Lines jumping around early on | Normal — metrics need ~500+ samples to stabilise |

The chart stores up to 300 snapshots (one per ~10 animation frames) and uses a 2,000-digit rolling buffer for the autocorrelation and runs calculations.

---

## Visual Design

- **Dark theme** built on a layered surface system (`--bg-base` → `--bg-surface` → `--bg-elevated` → `--bg-overlay`)
- **Space Grotesk** (Google Fonts) for UI labels and statistics — geometric, technical, contemporary
- **JetBrains Mono** (Google Fonts) for grid digits, equations, and code values — designed for readability at small sizes
- **CSS custom properties** for all design tokens — colours, radii, shadows, transitions
- **Responsive** via CSS Grid with `clamp()` fluid sizing; collapses to single-column on mobile
- **WCAG contrast** — each grid cell's text colour is computed from the background's relative luminance to maintain readability at all heatmap colours
- **Segmented size control** — 20×20 / 50×50 / 100×100 selector; locked while running to prevent mid-session state corruption

---

## How to Run

Because `AudioWorklet.addModule()` requires a secure context (HTTPS or localhost), the project **cannot be opened directly as a `file://` URL**. You need a local HTTP server.

### Option 1 — npx serve (recommended, zero install)

```bash
cd /path/to/Roz-Manifestation-Tester
npx serve .
```

Open `http://localhost:3000` in your browser.

### Option 2 — Python

```bash
cd /path/to/Roz-Manifestation-Tester
python3 -m http.server 8080
```

Open `http://localhost:8080`.

### Option 3 — VS Code Live Server

Install the **Live Server** extension, right-click `index.html`, and select *Open with Live Server*.

### Browser Requirements

| Requirement | Notes |
|---|---|
| `AudioWorklet` API | Chrome 66+, Firefox 76+, Safari 14.1+ |
| `crypto.subtle.digest` | All modern browsers (requires HTTPS or localhost) |
| `MediaDevices.getUserMedia` | Requires microphone permission grant |
| ES Modules (`type="module"`) | All modern browsers |

### Usage

1. Select a grid size using the **20×20 / 50×50 / 100×100** segmented control (default: 100×100)
2. Click **Start** — the browser will request microphone permission
3. A slim seeding bar fills as the entropy pool accumulates 2,048 debiased bits (~0.5 seconds)
4. Once seeded, the grid begins updating continuously and the trend chart starts plotting
5. Watch the heatmap: a healthy source produces a near-uniform grey field with occasional colour flickers
6. Watch the trend chart: all three lines should remain within their confidence bands
7. Click **Stop** to halt everything — the mic is released, all data is cleared, and the grid returns to its placeholder state. The size selector is re-enabled and Start can be pressed again

---

## Limitations & Notes

- **Microphone quality matters.** A high-quality external microphone will produce more thermal noise than a cheap built-in one. In a very quiet room with a good mic, the signal is almost pure thermal noise.
- **Loud environments** introduce structured audio (speech, music) into the higher bits. The LSB extraction and SHA-256 whitening mitigate this, but the entropy quality is highest in a quiet environment.
- **Mobile browsers** may apply additional audio processing that cannot be fully disabled via constraints. The Von Neumann debiasing and SHA-256 whitening compensate for this.
- **The `AudioWorklet` worklet file** (`worklets/lsb-processor.js`) must be served from the same origin as `index.html`. It cannot be loaded cross-origin.
- **Trend chart accuracy improves with time.** The autocorrelation and runs test use a 2,000-digit rolling buffer. Results before ~500 samples should be treated as indicative only.

---

## References

- Von Neumann, J. (1951). *Various techniques used in connection with random digits.* Applied Math Series, 12, 36–38.
- Eastlake, D. et al. (2005). *RFC 4086: Randomness Requirements for Security.* IETF.
- Wilson, E. B. & Hilferty, M. M. (1931). *The distribution of chi-square.* PNAS, 17(12), 684–688.
- Abramowitz, M. & Stegun, I. A. (1964). *Handbook of Mathematical Functions.* Dover. (§26.2.17)
- Wald, A. & Wolfowitz, J. (1940). *On a test whether two samples are from the same population.* Annals of Mathematical Statistics, 11(2), 147–162.
- Bartlett, M. S. (1946). *On the theoretical specification of sampling properties of autocorrelated time series.* Journal of the Royal Statistical Society, 8(1), 27–41.
- Web Audio API specification: https://webaudio.github.io/web-audio-api/
- SubtleCrypto API: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
- NIST Statistical Test Suite: https://csrc.nist.gov/publications/detail/sp/800-22/rev-1a/final
