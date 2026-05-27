/**
 * Grid — N×N display with continuous rAF update loop
 *
 * Design decisions:
 *  - Size (20, 50, 100) is passed at construction; TOTAL and CELLS_PER_FRAME
 *    scale accordingly so update cadence feels consistent across all sizes.
 *  - CSS column count is driven by a --grid-cols custom property set directly
 *    on the grid element, avoiding any class-switching or style recalculation.
 *  - Cells are pre-rendered as a flat array of <span> elements stored in a
 *    DocumentFragment, then appended once (single reflow).
 *  - Background colour comes from Heatmap; digit text uses contrast-adaptive
 *    foreground computed from WCAG 2.1 relative luminance.
 *  - Histogram bars update via CSS custom properties to avoid layout thrashing.
 */

// Supported grid sizes with tuned cells-per-frame for ~60fps
const SIZE_CONFIG = {
  20:  { cellsPerFrame: 10  },
  50:  { cellsPerFrame: 40  },
  100: { cellsPerFrame: 150 },
};

export class Grid {
  static SUPPORTED_SIZES = [20, 50, 100];
  static DEFAULT_SIZE    = 100;

  constructor(gridEl, histogramEl, statsEl, rng, heatmap, size = Grid.DEFAULT_SIZE, analyser = null, trendChart = null) {
    this._gridEl       = gridEl;
    this._histogramEl  = histogramEl;
    this._statsEl      = statsEl;
    this._rng          = rng;
    this._heatmap      = heatmap;
    this._analyser     = analyser;
    this._trendChart   = trendChart;
    this._size         = size;
    this._total        = size * size;
    this._cellsPerFrame = SIZE_CONFIG[size]?.cellsPerFrame ?? 150;
    this._cells        = [];
    this._writePtr     = 0;
    this._rafId        = null;
    this._updating     = false;
    this._totalGenerated = 0;
    this._histBars     = [];
    this._running      = false;
  }

  /** Build DOM once, then start the loop */
  init() {
    this._buildGrid();
    this._buildHistogram();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._loop();
  }

  stop() {
    this._running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  /** Clear DOM so a fresh Grid instance can re-init into the same containers */
  destroy() {
    this.stop();
    this._gridEl.innerHTML = '';
    this._histogramEl.innerHTML = '';
  }

  /**
   * Static — renders placeholder cells into a container for a given size.
   * Called before any Grid instance exists (page load, after stop).
   */
  static buildPlaceholder(gridEl, size = Grid.DEFAULT_SIZE) {
    gridEl.innerHTML = '';
    gridEl.style.setProperty('--grid-cols', size);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < size * size; i++) {
      const cell = document.createElement('span');
      cell.className = 'cell cell--placeholder';
      frag.appendChild(cell);
    }
    gridEl.appendChild(frag);
  }

  /** @private */
  _buildGrid() {
    this._gridEl.innerHTML = '';
    this._gridEl.style.setProperty('--grid-cols', this._size);
    this._cells = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < this._total; i++) {
      const cell = document.createElement('span');
      cell.className = 'cell';
      cell.textContent = '·';
      frag.appendChild(cell);
      this._cells.push(cell);
    }
    this._gridEl.appendChild(frag);
  }

  _buildHistogram() {
    this._histogramEl.innerHTML = '';
    for (let d = 0; d < 10; d++) {
      const col = document.createElement('div');
      col.className = 'hist-col';

      const bar = document.createElement('div');
      bar.className = 'hist-bar';

      const label = document.createElement('span');
      label.className = 'hist-label';
      label.textContent = d;

      const count = document.createElement('span');
      count.className = 'hist-count';
      count.textContent = '0';

      col.appendChild(bar);
      col.appendChild(label);
      col.appendChild(count);
      this._histogramEl.appendChild(col);
      this._histBars.push({ bar, count });
    }
  }

  /** @private — main animation loop */
  _loop() {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(() => this._loop());
    // Guard: don't start a new update batch if the previous one is still resolving
    if (!this._updating) this._updateCells();
  }

  async _updateCells() {
    this._updating = true;
    const promises = [];
    for (let i = 0; i < this._cellsPerFrame; i++) {
      promises.push(this._rng.nextDigit());
    }

    const digits = await Promise.all(promises);

    // Guard: if grid was stopped while awaiting, discard results
    if (!this._running) {
      this._updating = false;
      return;
    }

    for (const digit of digits) {
      if (digit === null) continue;

      this._heatmap.record(digit);
      this._analyser?.record(digit);
      const cell = this._cells[this._writePtr];
      const colour = this._heatmap.colourFor(digit);

      cell.textContent = digit;
      cell.style.backgroundColor = colour;
      cell.style.color = this._contrastColour(colour);

      this._writePtr = (this._writePtr + 1) % this._total;
      this._totalGenerated++;
    }
    this._updating = false;
    // Histogram, stats and trend chart at lower cadence (every ~10 frames)
    if (this._totalGenerated % (this._cellsPerFrame * 10) < this._cellsPerFrame) {
      this._updateHistogram();
      this._updateStats();
      if (this._analyser && this._trendChart) {
        this._trendChart.push(this._analyser.getSnapshot());
      }
    }
  }

  _updateHistogram() {
    const stats = this._heatmap.getStats();
    const maxCount = Math.max(...stats.map(s => s.count), 1);

    stats.forEach(({ digit, count, z }) => {
      const { bar, count: countEl } = this._histBars[digit];
      const pct = (count / maxCount) * 100;
      bar.style.setProperty('--bar-height', `${pct}%`);
      // Colour the bar by its own Z-score
      bar.style.setProperty('--bar-colour', this._heatmap.colourFor(digit));
      countEl.textContent = count.toLocaleString();
    });
  }

  _updateStats() {
    const chi2 = this._heatmap.chiSquared().toFixed(3);
    const p = this._heatmap.pValue().toFixed(4);
    const pClass = parseFloat(p) > 0.05 ? 'stat-pass' : 'stat-fail';
    this._statsEl.innerHTML =
      `<span>χ² = <strong>${chi2}</strong></span>` +
      `<span>df = <strong>9</strong></span>` +
      `<span>p = <strong class="${pClass}">${p}</strong></span>` +
      `<span>n = <strong>${this._totalGenerated.toLocaleString()}</strong></span>`;
  }

  /**
   * Returns white or near-black for readable text on a given hex background.
   * Uses relative luminance (WCAG 2.1 formula).
   */
  _contrastColour(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const lin = v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.179 ? '#0d1117' : '#e8eaf6';
  }
}
