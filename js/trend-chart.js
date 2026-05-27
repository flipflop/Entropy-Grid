/**
 * TrendChart — SVG multi-series randomness trend chart
 *
 * Renders three series on a shared time axis (sample count):
 *   - Lag-1 autocorrelation r₁  (cyan line, ±1.96/√N confidence band)
 *   - Runs test Z-score          (amber line, ±1.96 band)
 *   - Chi-squared p-value        (blue line, p=0.05 threshold)
 *
 * All drawing is done by mutating a single SVG element's innerHTML —
 * one string build per frame, one DOM write, zero layout thrashing.
 * Updates are gated behind a dirty flag so rAF is only consumed when
 * new data has actually arrived.
 */
export class TrendChart {
  static MAX_POINTS = 300;

  // SVG viewport
  static W  = 800;
  static H  = 180;
  static PAD = { top: 16, right: 16, bottom: 32, left: 44 };

  constructor(svgEl) {
    this._svg     = svgEl;
    this._history = [];   // array of snapshots
    this._dirty   = false;
    this._rafId   = null;

    svgEl.setAttribute('viewBox', `0 0 ${TrendChart.W} ${TrendChart.H}`);
    svgEl.setAttribute('preserveAspectRatio', 'none');
  }

  push(snapshot) {
    if (!snapshot) return;
    this._history.push(snapshot);
    if (this._history.length > TrendChart.MAX_POINTS) {
      this._history.shift();
    }
    this._dirty = true;
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        if (this._dirty) { this._draw(); this._dirty = false; }
      });
    }
  }

  reset() {
    this._history = [];
    this._dirty   = true;
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        this._draw();
        this._dirty = false;
      });
    }
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  _draw() {
    const { W, H, PAD } = TrendChart;
    const pts  = this._history;
    const cW   = W - PAD.left - PAD.right;
    const cH   = H - PAD.top  - PAD.bottom;

    if (pts.length < 2) {
      this._svg.innerHTML = this._emptyState(W, H, PAD, cW, cH);
      return;
    }

    const xOf  = i  => PAD.left + (i / (pts.length - 1)) * cW;

    // ── r₁ and runsZ share the y-axis [-2.5, 2.5] ──
    const yZ   = v  => PAD.top + cH * (1 - (Math.max(-2.5, Math.min(2.5, v)) + 2.5) / 5);

    // ── p-value on a separate right axis [0, 1] ──
    const yP   = v  => PAD.top + cH * (1 - Math.max(0, Math.min(1, v)));

    // Confidence bands (vary per point for r₁, fixed for runsZ)
    const r1BandPath  = this._bandPath(pts, xOf,
      p => yZ( p.band95), p => yZ(-p.band95));
    const runsBandPath = this._bandPath(pts, xOf,
      _  => yZ( 1.96),    _  => yZ(-1.96));

    // Series lines
    const r1Line    = this._linePath(pts, xOf, p => yZ(p.r1));
    const runsLine  = this._linePath(pts, xOf, p => yZ(p.runsZ));
    const pLine     = this._linePath(pts, xOf, p => yP(p.pValue));

    // p=0.05 threshold line
    const pThreshY  = yP(0.05);
    const pThreshX1 = PAD.left;
    const pThreshX2 = PAD.left + cW;

    // Zero line for Z-axis
    const zeroY = yZ(0);

    // X-axis labels (sample counts)
    const first = pts[0].n;
    const last  = pts[pts.length - 1].n;
    const xLabels = this._xLabels(pts, xOf, first, last, PAD, cH);

    // Y-axis labels (Z-score left, p-value right)
    const yLabels = this._yLabels(PAD, cH, cW);

    this._svg.innerHTML = `
      <defs>
        <clipPath id="chart-clip">
          <rect x="${PAD.left}" y="${PAD.top}" width="${cW}" height="${cH}"/>
        </clipPath>
      </defs>

      <!-- Chart background -->
      <rect x="${PAD.left}" y="${PAD.top}" width="${cW}" height="${cH}"
            fill="#0d1117" rx="4"/>

      <!-- Horizontal grid lines at Z = ±1, ±2 -->
      ${[-2,-1,0,1,2].map(z => {
        const y = yZ(z);
        return `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left+cW}" y2="${y}"
                      stroke="#21262d" stroke-width="1"
                      ${z === 0 ? 'stroke-dasharray="none"' : 'stroke-dasharray="3,3"'}/>`;
      }).join('')}

      <!-- p=0.05 threshold -->
      <line x1="${pThreshX1}" y1="${pThreshY}" x2="${pThreshX2}" y2="${pThreshY}"
            stroke="#484f58" stroke-width="1" stroke-dasharray="4,4"
            clip-path="url(#chart-clip)"/>

      <!-- Confidence bands (clipped) -->
      <path d="${r1BandPath}"   fill="#4fc3f7" fill-opacity="0.08"
            clip-path="url(#chart-clip)"/>
      <path d="${runsBandPath}" fill="#f5a623" fill-opacity="0.06"
            clip-path="url(#chart-clip)"/>

      <!-- Series lines (clipped) -->
      <path d="${r1Line}"   fill="none" stroke="#4fc3f7" stroke-width="1.5"
            stroke-linejoin="round" stroke-linecap="round"
            clip-path="url(#chart-clip)"/>
      <path d="${runsLine}" fill="none" stroke="#f5a623" stroke-width="1.5"
            stroke-linejoin="round" stroke-linecap="round"
            clip-path="url(#chart-clip)"/>
      <path d="${pLine}"    fill="none" stroke="#1a6cf5" stroke-width="1.5"
            stroke-linejoin="round" stroke-linecap="round"
            clip-path="url(#chart-clip)"/>

      <!-- Axes -->
      <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top+cH}"
            stroke="#30363d" stroke-width="1"/>
      <line x1="${PAD.left}" y1="${PAD.top+cH}" x2="${PAD.left+cW}" y2="${PAD.top+cH}"
            stroke="#30363d" stroke-width="1"/>

      ${yLabels}
      ${xLabels}

      <!-- Legend -->
      ${this._legend(W, PAD)}
    `;
  }

  _emptyState(W, H, PAD, cW, cH) {
    return `
      <rect x="${PAD.left}" y="${PAD.top}" width="${cW}" height="${cH}"
            fill="#0d1117" rx="4"/>
      <text x="${W/2}" y="${H/2}" text-anchor="middle" dominant-baseline="middle"
            fill="#484f58" font-family="JetBrains Mono, monospace" font-size="11">
        Waiting for data…
      </text>`;
  }

  _linePath(pts, xOf, yOf) {
    return pts.map((p, i) =>
      `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p).toFixed(1)}`
    ).join(' ');
  }

  _bandPath(pts, xOf, yTop, yBot) {
    const top = pts.map((p, i) => `${i===0?'M':'L'}${xOf(i).toFixed(1)},${yTop(p).toFixed(1)}`).join(' ');
    const bot = [...pts].reverse().map((p, i) => `${i===0?'L':'L'}${xOf(pts.length-1-i).toFixed(1)},${yBot(p).toFixed(1)}`).join(' ');
    return `${top} ${bot} Z`;
  }

  _xLabels(pts, xOf, first, last, PAD, cH) {
    const y = PAD.top + cH + 18;
    const mid = Math.floor(pts.length / 2);
    return [
      { i: 0,   n: first },
      { i: mid, n: pts[mid].n },
      { i: pts.length - 1, n: last },
    ].map(({ i, n }) =>
      `<text x="${xOf(i).toFixed(1)}" y="${y}" text-anchor="middle"
             fill="#484f58" font-family="JetBrains Mono,monospace" font-size="9">
        ${n.toLocaleString()}
       </text>`
    ).join('');
  }

  _yLabels(PAD, cH, cW) {
    const labels = [];
    // Left axis: Z-score
    [-2, -1, 0, 1, 2].forEach(z => {
      const y = PAD.top + cH * (1 - (z + 2.5) / 5);
      labels.push(
        `<text x="${PAD.left - 6}" y="${y.toFixed(1)}" text-anchor="end"
               dominant-baseline="middle"
               fill="#484f58" font-family="JetBrains Mono,monospace" font-size="9">
           ${z}
         </text>`
      );
    });
    // Right axis: p-value
    [0, 0.05, 0.5, 1].forEach(p => {
      const y = PAD.top + cH * (1 - p);
      labels.push(
        `<text x="${PAD.left + cW + 6}" y="${y.toFixed(1)}" text-anchor="start"
               dominant-baseline="middle"
               fill="${p === 0.05 ? '#484f58' : '#30363d'}"
               font-family="JetBrains Mono,monospace" font-size="9">
           ${p}
         </text>`
      );
    });
    // Axis titles
    labels.push(
      `<text x="${PAD.left - 32}" y="${PAD.top + cH/2}" text-anchor="middle"
             dominant-baseline="middle" transform="rotate(-90,${PAD.left-32},${PAD.top+cH/2})"
             fill="#484f58" font-family="Space Grotesk,sans-serif" font-size="8" letter-spacing="0.08em">
         Z-SCORE
       </text>`,
      `<text x="${PAD.left + cW + 32}" y="${PAD.top + cH/2}" text-anchor="middle"
             dominant-baseline="middle" transform="rotate(90,${PAD.left+cW+32},${PAD.top+cH/2})"
             fill="#30363d" font-family="Space Grotesk,sans-serif" font-size="8" letter-spacing="0.08em">
         p-VALUE
       </text>`
    );
    return labels.join('');
  }

  _legend(W, PAD) {
    const y  = PAD.top - 4;
    const items = [
      { colour: '#4fc3f7', label: 'Autocorr r₁',   x: PAD.left },
      { colour: '#f5a623', label: 'Runs Z-score',   x: PAD.left + 110 },
      { colour: '#1a6cf5', label: 'χ² p-value',     x: PAD.left + 220 },
      { colour: '#484f58', label: 'p=0.05 / ±1.96', x: PAD.left + 320, dash: true },
    ];
    return items.map(({ colour, label, x, dash }) => `
      <line x1="${x}" y1="${y}" x2="${x+18}" y2="${y}"
            stroke="${colour}" stroke-width="${dash ? 1 : 1.5}"
            ${dash ? 'stroke-dasharray="4,3"' : ''}/>
      <text x="${x+22}" y="${y}" dominant-baseline="middle"
            fill="#8b949e" font-family="Space Grotesk,sans-serif" font-size="9">
        ${label}
      </text>
    `).join('');
  }
}
