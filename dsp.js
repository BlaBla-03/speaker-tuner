// dsp.js — pure DSP helpers (no DOM). Runs in the browser and in Node (for tests).

export const F_MIN = 20;
export const F_MAX = 20000;

/** Log-spaced frequency grid used for every curve in the app. */
export function logFreqs(n = 256, lo = F_MIN, hi = F_MAX) {
  const out = new Float64Array(n);
  const r = Math.log(hi / lo);
  for (let i = 0; i < n; i++) out[i] = lo * Math.exp((r * i) / (n - 1));
  return out;
}

/** Small deterministic PRNG so generated noise is reproducible when seeded. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place iterative radix-2 complex FFT. n must be a power of two. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const half = n >> 1;
  const cosT = new Float64Array(half);
  const sinT = new Float64Array(half);
  const sgn = inverse ? 1 : -1;
  for (let k = 0; k < half; k++) {
    cosT[k] = Math.cos((2 * Math.PI * k) / n);
    sinT[k] = sgn * Math.sin((2 * Math.PI * k) / n);
  }
  for (let len = 2; len <= n; len <<= 1) {
    const h = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < h; k++) {
        const wr = cosT[k * step], wi = sinT[k * step];
        const a = i + k, b = a + h;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * Exact, seamlessly-loopable pink noise (power ∝ 1/f) band-limited to [lo, hi].
 * Built in the frequency domain so the buffer loops without a click.
 */
export function makePinkNoise(n, fs, { lo = F_MIN, hi = F_MAX, rms = 0.15, seed } = {}) {
  const re = new Float64Array(n), im = new Float64Array(n);
  const rand = mulberry32(seed ?? Math.floor(Math.random() * 2 ** 32));
  for (let k = 1; k < n / 2; k++) {
    const f = (k * fs) / n;
    if (f < lo || f > hi) continue;
    const mag = 1 / Math.sqrt(f);
    const ph = rand() * 2 * Math.PI;
    re[k] = mag * Math.cos(ph); im[k] = mag * Math.sin(ph);
    re[n - k] = re[k]; im[n - k] = -im[k];
  }
  fft(re, im, true);
  let s = 0;
  for (let i = 0; i < n; i++) s += re[i] * re[i];
  const g = rms / Math.sqrt(s / n);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, re[i] * g));
  return out;
}

/** Exponential (log) sine sweep, with short fades, followed by silence. */
export function makeLogSweep(fs, { seconds = 10, lo = F_MIN, hi = F_MAX, amp = 0.35, gapSeconds = 0.6 } = {}) {
  const n = Math.round(seconds * fs);
  const out = new Float32Array(n + Math.round(gapSeconds * fs));
  const L = seconds / Math.log(hi / lo);
  const fade = Math.round(0.02 * fs);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    let v = amp * Math.sin(2 * Math.PI * lo * L * (Math.exp(t / L) - 1));
    if (i < fade) v *= i / fade;
    if (i > n - fade) v *= (n - i) / fade;
    out[i] = v;
  }
  return out;
}

/**
 * Precompute, for each grid frequency, the FFT-bin range covering a 1/frac-octave band.
 * Returns {lo, hi} Int32Arrays of inclusive bin indices.
 */
export function makeBandMap(freqs, binHz, nBins, frac = 6) {
  const halfBw = Math.pow(2, 1 / (2 * frac));
  const lo = new Int32Array(freqs.length), hi = new Int32Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    let a = Math.ceil(freqs[i] / halfBw / binHz);
    let b = Math.floor((freqs[i] * halfBw) / binHz);
    a = Math.max(1, Math.min(nBins - 1, a));
    b = Math.max(1, Math.min(nBins - 1, b));
    if (b < a) a = b = Math.max(1, Math.min(nBins - 1, Math.round(freqs[i] / binHz)));
    lo[i] = a; hi[i] = b;
  }
  return { lo, hi };
}

/**
 * Average linear power per band, then express it as dB with pink-noise compensation
 * (+10·log10 f) so that a perfectly flat speaker playing pink noise reads as a flat line.
 */
export function powerToResponse(power, freqs, map) {
  const n = power.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + power[i];
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const a = map.lo[i], b = map.hi[i];
    const mean = (cum[b + 1] - cum[a]) / (b - a + 1);
    out[i] = 10 * Math.log10(Math.max(mean, 1e-30)) + 10 * Math.log10(freqs[i]);
  }
  return out;
}

/** Magnitude (dB) of an RBJ peaking biquad at frequency f. */
export function peakingDb(f, fc, gainDb, q, fs = 48000) {
  if (gainDb === 0) return 0;
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * fc) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const c = Math.cos(w0);
  const b0 = 1 + alpha * A, b1 = -2 * c, b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A, a1 = -2 * c, a2 = 1 - alpha / A;
  const w = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * cw + b2 * c2, ni = -(b1 * sw + b2 * s2);
  const dr = a0 + a1 * cw + a2 * c2, di = -(a1 * sw + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

export function filterCurve(freqs, f, fs = 48000) {
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) out[i] = peakingDb(freqs[i], f.fc, f.gain, f.q, fs);
  return out;
}

export function eqCurve(freqs, filters, fs = 48000) {
  const out = new Float64Array(freqs.length);
  for (const f of filters) {
    if (!f.gain) continue;
    for (let i = 0; i < freqs.length; i++) out[i] += peakingDb(freqs[i], f.fc, f.gain, f.q, fs);
  }
  return out;
}

// ---------- Target curves ----------

const lowShelf = (f, fc, g) => g / (1 + Math.pow(f / fc, 2));
const highShelf = (f, fc, g) => (g * Math.pow(f / fc, 2)) / (1 + Math.pow(f / fc, 2));

export const TARGETS = {
  flat: { name: 'Flat (studio / reference)', fn: () => 0 },
  natural: { name: 'Natural (gentle bass lift, smooth treble)', fn: (f) => lowShelf(f, 105, 4) + highShelf(f, 4000, -2.5) },
  car: { name: 'Car (strong bass, relaxed treble)', fn: (f) => lowShelf(f, 90, 8) + highShelf(f, 3500, -3) },
  laptop: { name: 'Laptop (clean, no bass overdrive)', fn: (f) => lowShelf(f, 200, 2) + highShelf(f, 6000, -1.5) },
  vocal: { name: 'Vocal / podcast clarity', fn: (f) => lowShelf(f, 120, -2) + peakingDb(f, 2500, 2, 0.8) },
};

export function targetCurve(freqs, key, bassDb = 0, trebleDb = 0) {
  const t = TARGETS[key] || TARGETS.flat;
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    out[i] = t.fn(f) + lowShelf(f, 120, bassDb) + highShelf(f, 5000, trebleDb);
  }
  return out;
}

// ---------- Helpers ----------

export function meanIn(freqs, arr, lo, hi, weights) {
  let s = 0, n = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] < lo || freqs[i] > hi) continue;
    const w = weights ? weights[i] : 1;
    s += arr[i] * w; n += w;
  }
  return n ? s / n : 0;
}

export function smoothLog(arr, halfWidthPts) {
  const n = arr.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - halfWidthPts); j <= Math.min(n - 1, i + halfWidthPts); j++) { s += arr[j]; c++; }
    out[i] = s / c;
  }
  return out;
}

/**
 * Find where the speaker stops producing usable bass: walking down from 300 Hz,
 * the first point where the (smoothed) response is >9 dB below the 300 Hz–3 kHz level.
 */
export function autoLowLimit(freqs, resp) {
  const ref = meanIn(freqs, resp, 300, 3000);
  const sm = smoothLog(resp, 4);
  let lim = freqs[0];
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] > 300) continue;
    if (sm[i] < ref - 9) { lim = freqs[i]; break; }
  }
  return Math.min(300, Math.max(30, lim * 1.1));
}

/**
 * Build the correction we want: target − measured, level-aligned in the fit range,
 * clipped so we never ask for big boosts (boosting nulls/roll-off wastes power and distorts).
 */
export function correctionNeeded(freqs, measured, target, weights, { maxBoost = 6, maxCut = 12 } = {}) {
  const diff = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) diff[i] = measured[i] - target[i];
  let s = 0, n = 0;
  for (let i = 0; i < freqs.length; i++) { s += diff[i] * weights[i]; n += weights[i]; }
  const off = n ? s / n : 0;
  const err = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) err[i] = Math.max(-maxCut, Math.min(maxBoost, -(diff[i] - off)));
  return { err, offset: off };
}

function weightedCost(err, cur, w) {
  let s = 0, n = 0;
  for (let i = 0; i < err.length; i++) { const d = err[i] - cur[i]; s += w[i] * d * d; n += w[i]; }
  return n ? s / n : 0;
}

/** Q for a graphic-EQ band from the spacing to its neighbours (≈1 octave → Q≈1.4). */
export function graphicQ(bands, i) {
  const left = i > 0 ? Math.log2(bands[i] / bands[i - 1]) : null;
  const right = i < bands.length - 1 ? Math.log2(bands[i + 1] / bands[i]) : null;
  const bw = Math.max(0.33, Math.min(3, left && right ? (left + right) / 2 : left || right || 1));
  const p = Math.pow(2, bw);
  return Math.sqrt(p) / (p - 1);
}

/**
 * Fit fixed-frequency graphic EQ gains (Spotify, car head unit) with exact
 * coordinate descent over the allowed step grid.
 */
export function fitGraphic(freqs, err, w, bands, { min = -12, max = 12, step = 1, q, fs = 48000, lambda = 0.01, preferCuts = false } = {}) {
  const qs = bands.map((_, i) => q || graphicQ(bands, i));
  const gains = bands.map(() => 0);
  const unit = bands.map((fc, i) => null);
  const curves = bands.map(() => new Float64Array(freqs.length));
  const total = new Float64Array(freqs.length);
  const cost = () => {
    let c = weightedCost(err, total, w);
    for (const g of gains) c += lambda * g * g;
    return c;
  };
  const setGain = (b, g) => {
    const old = curves[b];
    const nc = g === 0 ? new Float64Array(freqs.length) : filterCurve(freqs, { fc: bands[b], gain: g, q: qs[b] }, fs);
    for (let i = 0; i < freqs.length; i++) total[i] += nc[i] - old[i];
    curves[b] = nc; gains[b] = g;
  };
  const grid = [];
  for (let g = min; g <= max + 1e-9; g += step) grid.push(Math.round(g / step) * step);
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let b = 0; b < bands.length; b++) {
      let best = gains[b], bestC = cost();
      for (const g of grid) {
        if (g === gains[b]) continue;
        setGain(b, g);
        const c = cost();
        if (c < bestC - 1e-9) { bestC = c; best = g; }
      }
      if (best !== gains[b]) changed = true;
      setGain(b, best);
    }
    if (!changed) break;
  }
  if (preferCuts) {
    const top = Math.max(...gains);
    if (top > 0) for (let b = 0; b < bands.length; b++) setGain(b, Math.max(min, Math.round((gains[b] - top) / step) * step));
  }
  void unit;
  return { bands: bands.map((fc, i) => ({ fc, gain: gains[i], q: qs[i] })), curve: Float64Array.from(total), rms: Math.sqrt(weightedCost(err, total, w)) };
}

/**
 * Fit a parametric EQ (Equalizer APO): greedily place peaking filters on the
 * biggest remaining error, then jointly refine centre, gain and Q.
 */
export function fitParametric(freqs, err, w, { maxFilters = 10, maxBoost = 6, maxCut = 12, fLo = 20, fHi = 20000, fs = 48000, lambda = 0.002, stopDb = 0.75 } = {}) {
  const filters = [];
  const curves = [];
  const total = new Float64Array(freqs.length);
  const cost = () => {
    let c = weightedCost(err, total, w);
    for (const f of filters) c += lambda * f.gain * f.gain;
    return c;
  };
  const replace = (k, f) => {
    const nc = filterCurve(freqs, f, fs);
    for (let i = 0; i < freqs.length; i++) total[i] += nc[i] - curves[k][i];
    curves[k] = nc; filters[k] = f;
  };
  const clampF = (f) => ({
    fc: Math.max(fLo, Math.min(fHi, f.fc)),
    gain: Math.max(-maxCut, Math.min(maxBoost, f.gain)),
    q: Math.max(0.4, Math.min(10, f.q)),
  });
  const refine = (iters = 25) => {
    let sFc = Math.pow(2, 1 / 6), sG = 1, sQ = 1.4;
    for (let it = 0; it < iters; it++) {
      let improved = false;
      for (let k = 0; k < filters.length; k++) {
        for (const mut of [
          (f) => ({ ...f, fc: f.fc * sFc }), (f) => ({ ...f, fc: f.fc / sFc }),
          (f) => ({ ...f, gain: f.gain + sG }), (f) => ({ ...f, gain: f.gain - sG }),
          (f) => ({ ...f, q: f.q * sQ }), (f) => ({ ...f, q: f.q / sQ }),
        ]) {
          const before = cost(), old = filters[k];
          replace(k, clampF(mut(old)));
          if (cost() < before - 1e-7) improved = true; else replace(k, old);
        }
      }
      if (!improved) {
        sFc = Math.pow(sFc, 0.5); sG *= 0.5; sQ = Math.pow(sQ, 0.5);
        if (sG < 0.05) break;
      }
    }
  };
  const inRange = (f) => f >= fLo && f <= fHi;
  for (let n = 0; n < maxFilters; n++) {
    const resid = new Float64Array(freqs.length);
    for (let i = 0; i < freqs.length; i++) resid[i] = (err[i] - total[i]) * (w[i] > 0 ? 1 : 0);
    const sm = smoothLog(resid, 3);
    let bi = -1, bv = 0;
    for (let i = 0; i < freqs.length; i++) {
      if (!inRange(freqs[i]) || w[i] <= 0) continue;
      if (Math.abs(sm[i]) > bv) { bv = Math.abs(sm[i]); bi = i; }
    }
    if (bi < 0 || bv < stopDb) break;
    const before = cost();
    let best = null, bestC = Infinity;
    filters.push({ fc: freqs[bi], gain: 0, q: 1 }); curves.push(new Float64Array(freqs.length));
    const k = filters.length - 1;
    for (const q of [0.5, 0.7, 1, 1.4, 2, 3, 4.5, 6]) {
      replace(k, clampF({ fc: freqs[bi], gain: sm[bi], q }));
      const c = cost();
      if (c < bestC) { bestC = c; best = filters[k]; }
    }
    replace(k, best);
    refine();
    if (cost() > before - 1e-4) {
      replace(k, { ...filters[k], gain: 0 });
      filters.pop(); curves.pop();
      break;
    }
  }
  const round = filters
    .map((f) => ({ fc: Math.round(f.fc), gain: Math.round(f.gain * 10) / 10, q: Math.round(f.q * 100) / 100 }))
    .filter((f) => Math.abs(f.gain) >= 0.2)
    .sort((a, b) => a.fc - b.fc);
  const curve = eqCurve(freqs, round, fs);
  let peak = 0;
  for (let i = 0; i < freqs.length; i++) peak = Math.max(peak, curve[i]);
  return { filters: round, curve, preamp: -Math.ceil(peak * 10) / 10, rms: Math.sqrt(weightedCost(err, curve, w)) };
}

export function apoConfig(result, label = 'Speaker Tuner') {
  const lines = [`# ${label} — generated ${new Date().toISOString().slice(0, 10)}`, `Preamp: ${result.preamp.toFixed(1)} dB`];
  result.filters.forEach((f, i) => lines.push(`Filter ${i + 1}: ON PK Fc ${f.fc} Hz Gain ${f.gain.toFixed(1)} dB Q ${f.q.toFixed(2)}`));
  return lines.join('\n');
}

/** Encode mono float samples as a 16-bit PCM WAV Blob/ArrayBuffer. */
export function encodeWav(samples, fs, channels = 1) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, fs, true); v.setUint32(28, fs * 2 * channels, true); v.setUint16(32, 2 * channels, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
  return buf;
}
