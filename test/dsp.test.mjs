// Node test: simulate a "speaker" with known coloration, measure it the way the
// app does (Blackman-windowed FFT frames, power averaging, 1/6-oct bands, pink compensation),
// then check that the EQ fitters undo the coloration.
import * as D from '../dsp.js';

const fs = 48000, N = 1 << 17;
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) fails++; };

// 1) Pink noise buffer: loop seam, level, spectrum slope
const pink = D.makePinkNoise(N, fs, { seed: 1 });
let s = 0; for (const x of pink) s += x * x;
check('pink RMS ≈ 0.15', Math.abs(Math.sqrt(s / N) - 0.15) < 0.01, Math.sqrt(s / N).toFixed(3));
check('pink seam small', Math.abs(pink[0] - pink[N - 1]) < 0.2, Math.abs(pink[0] - pink[N - 1]).toFixed(3));

// 2) "Speaker": apply known coloration in frequency domain (circular, like a looped signal)
const speaker = [
  { fc: 120, gain: -12, q: 0.7 },  // weak bass (laptop-like)
  { fc: 900, gain: 6, q: 2 },      // boxy resonance
  { fc: 3500, gain: -5, q: 1.5 },  // dip
  { fc: 9000, gain: 4, q: 1 },     // sizzle
];
const re = Float64Array.from(pink), im = new Float64Array(N);
D.fft(re, im);
for (let k = 1; k < N / 2; k++) {
  const f = (k * fs) / N;
  let db = 0; for (const p of speaker) db += D.peakingDb(f, p.fc, p.gain, p.q, fs);
  const g = Math.pow(10, db / 20);
  re[k] *= g; im[k] *= g; re[N - k] = re[k]; im[N - k] = -im[k];
}
D.fft(re, im, true);

// 3) Analyse like an AnalyserNode (fftSize 32768, Blackman), averaging power over hops
const M = 32768, bins = M / 2;
const win = new Float64Array(M);
for (let i = 0; i < M; i++) win[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / M) + 0.08 * Math.cos((4 * Math.PI * i) / M);
const power = new Float64Array(bins);
let frames = 0;
for (let start = 0; start + M <= N * 3; start += M / 4) {
  const fr = new Float64Array(M), fi = new Float64Array(M);
  for (let i = 0; i < M; i++) fr[i] = re[(start + i) % N] * win[i];
  D.fft(fr, fi);
  for (let k = 0; k < bins; k++) power[k] += fr[k] * fr[k] + fi[k] * fi[k];
  frames++;
  if (frames > 40) break;
}
for (let k = 0; k < bins; k++) power[k] /= frames;

const freqs = D.logFreqs(256);
const map = D.makeBandMap(freqs, fs / M, bins, 6);
let resp = D.powerToResponse(power, freqs, map);
const ref = D.meanIn(freqs, resp, 300, 3000);
resp = resp.map((v) => v - ref);

// Expected (smoothed truth)
const truth = D.eqCurve(freqs, speaker, fs);
const tref = D.meanIn(freqs, truth, 300, 3000);
let maxErr = 0;
for (let i = 0; i < freqs.length; i++) if (freqs[i] > 40 && freqs[i] < 18000) maxErr = Math.max(maxErr, Math.abs(resp[i] - (truth[i] - tref)));
check('measured response matches truth (1/6 oct)', maxErr < 2.5, `max err ${maxErr.toFixed(2)} dB`);

// 4) Auto low limit should land near the bass roll-off
const lowLim = D.autoLowLimit(freqs, resp);
check('auto low limit sensible', lowLim > 30 && lowLim < 200, `${lowLim.toFixed(0)} Hz`);

// 5) Parametric fit (flat target), fit range 40 Hz – 16 kHz
const target = D.targetCurve(freqs, 'flat');
const w = Float64Array.from(freqs, (f) => (f >= 40 && f <= 16000 ? 1 : 0));
const { err } = D.correctionNeeded(freqs, resp, target, w, { maxBoost: 12, maxCut: 12 });
const par = D.fitParametric(freqs, err, w, { maxFilters: 10, maxBoost: 12, fLo: 40, fHi: 16000 });
console.log(D.apoConfig(par, 'test'));
check('parametric residual small', par.rms < 1.0, `rms ${par.rms.toFixed(2)} dB, ${par.filters.length} filters`);
check('preamp prevents clipping', par.preamp <= 0);

// 6) Default safety limits: boost capped at +6
const lim = D.correctionNeeded(freqs, resp, target, w);
const parSafe = D.fitParametric(freqs, lim.err, w, { fLo: 40, fHi: 16000 });
check('safe mode: no filter boosts > 6 dB', parSafe.filters.every((f) => f.gain <= 6.01));

// 7) Graphic fits
const spotify = D.fitGraphic(freqs, err, w, [60, 150, 400, 1000, 2400, 15000], { min: -12, max: 12, step: 0.5 });
console.log('Spotify:', spotify.bands.map((b) => `${b.fc}:${b.gain}`).join('  '), 'rms', spotify.rms.toFixed(2));
const before = Math.sqrt(err.reduce((a, e, i) => a + w[i] * e * e, 0) / w.reduce((a, b) => a + b, 0));
check('Spotify fit improves error', spotify.rms < before * 0.75, `${before.toFixed(2)} → ${spotify.rms.toFixed(2)} dB`);
const car = D.fitGraphic(freqs, err, w, [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000], { min: -10, max: 10, step: 1 });
console.log('Car 10-band:', car.bands.map((b) => `${b.fc}:${b.gain}`).join('  '), 'rms', car.rms.toFixed(2));
check('10-band fit improves error', car.rms < before * 0.6, `${before.toFixed(2)} → ${car.rms.toFixed(2)} dB`);

// 8) WAV encoder header
const wav = new DataView(D.encodeWav(new Float32Array(100), fs));
check('WAV header', wav.getUint32(24, true) === fs && wav.byteLength === 244);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
