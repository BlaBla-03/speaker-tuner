import * as D from './dsp.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const FREQS = D.logFreqs(256);
const SPOTIFY_BANDS = [60, 150, 400, 1000, 2400, 15000];
const CAR_PRESETS = {
  iso10: [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
  seven: [63, 160, 400, 1000, 2500, 6300, 16000],
  five: [60, 250, 1000, 4000, 12000],
  three: [100, 1000, 10000],
};
const COLORS = ['#38bdf8', '#f472b6', '#a78bfa', '#fb923c', '#34d399', '#facc15', '#60a5fa', '#f87171'];
const STORE_KEY = 'speakerTuner.v1';

// ---------------- State ----------------

const uid = () => Math.random().toString(36).slice(2, 10);
function newProfile(name, kind) {
  return {
    id: uid(), name, kind,
    target: kind === 'car' ? 'car' : kind === 'laptop' ? 'laptop' : 'natural',
    bass: 0, treble: 0, maxBoost: kind === 'laptop' ? 3 : 6, low: null, high: 14000,
    car: { preset: 'iso10', bands: CAR_PRESETS.iso10.slice(), min: -10, max: 10, step: 1 },
    measurements: [],
  };
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.profiles) && s.profiles.length) return s;
  } catch {}
  const car = newProfile('My car', 'car'), laptop = newProfile('Laptop', 'laptop');
  return { profiles: [car, laptop], current: car.id, ui: { source: 'internal', channel: 'both', level: -10, pred: 'spotify' } };
}
const state = loadState();
state.ui ??= { source: 'internal', channel: 'both', level: -10, pred: 'spotify' };
const save = () => localStorage.setItem(STORE_KEY, JSON.stringify(state));
const prof = () => state.profiles.find((p) => p.id === state.current) || state.profiles[0];

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------------- Audio engine ----------------

const A = { ctx: null, mic: null, micSrc: null, an: null, meter: null, sink: null, out: null, src: null, buffers: {}, map: null, wake: null };

function ensureCtx() {
  if (!A.ctx) {
    A.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    A.out = A.ctx.createGain(); A.out.gain.value = 0; A.out.connect(A.ctx.destination);
  }
  if (A.ctx.state !== 'running') A.ctx.resume().catch(() => {});
  return A.ctx;
}
function setSession(type) { try { if (navigator.audioSession) navigator.audioSession.type = type; } catch {} }

async function ensureMic() {
  ensureCtx();
  if (A.mic && A.mic.active) return;
  setSession('play-and-record');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not allow microphone access here (the page must be opened over https).');
  A.mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const ctx = A.ctx;
  await ctx.resume().catch(() => {});
  A.micSrc = ctx.createMediaStreamSource(A.mic);
  A.an = ctx.createAnalyser(); A.an.fftSize = 32768; A.an.smoothingTimeConstant = 0;
  A.meter = ctx.createAnalyser(); A.meter.fftSize = 2048;
  // Safari only processes nodes that eventually reach the destination: route through a muted gain.
  A.sink = ctx.createGain(); A.sink.gain.value = 0;
  A.micSrc.connect(A.an); A.micSrc.connect(A.meter);
  A.an.connect(A.sink); A.meter.connect(A.sink); A.sink.connect(ctx.destination);
  A.map = D.makeBandMap(FREQS, ctx.sampleRate / A.an.fftSize, A.an.frequencyBinCount, 6);
  startMeter();
}

function getBuffer(kind) {
  const ctx = ensureCtx(), fs = ctx.sampleRate;
  const key = `${kind}@${fs}`;
  if (A.buffers[key]) return A.buffers[key];
  let L, R;
  if (kind === 'sweep') {
    L = D.makeLogSweep(fs); R = L;
  } else {
    const n = 1 << 19; // ~11 s, loops seamlessly
    const a = getPinkRaw(n, fs, 1), b = getPinkRaw(n, fs, 2);
    if (kind === 'both') { L = a; R = b; }            // uncorrelated L/R: no comb filtering between speakers
    else if (kind === 'left') { L = a; R = new Float32Array(n); }
    else if (kind === 'right') { L = new Float32Array(n); R = a; }
    else if (kind === 'inphase') { L = a; R = a; }
    else if (kind === 'outphase') { L = a; R = a.map((x) => -x); }
  }
  const buf = ctx.createBuffer(2, L.length, fs);
  buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
  return (A.buffers[key] = buf);
}
const pinkCache = {};
function getPinkRaw(n, fs, seed) {
  const k = `${n}/${fs}/${seed}`;
  return (pinkCache[k] ??= D.makePinkNoise(n, fs, { seed, rms: 0.18 }));
}

function play(kind, levelDb) {
  const ctx = ensureCtx();
  stopPlay(true);
  const src = ctx.createBufferSource();
  src.buffer = getBuffer(kind); src.loop = true; src.connect(A.out);
  const g = Math.pow(10, levelDb / 20), t = ctx.currentTime;
  A.out.gain.cancelScheduledValues(t);
  A.out.gain.setValueAtTime(0, t);
  A.out.gain.linearRampToValueAtTime(g, t + 0.3);
  src.start();
  A.src = src;
}
function setPlayLevel(levelDb) {
  if (!A.src) return;
  A.out.gain.setTargetAtTime(Math.pow(10, levelDb / 20), A.ctx.currentTime, 0.05);
}
function stopPlay(immediate = false) {
  if (!A.src) return;
  const src = A.src, t = A.ctx.currentTime;
  A.src = null;
  A.out.gain.cancelScheduledValues(t);
  A.out.gain.setValueAtTime(A.out.gain.value, t);
  A.out.gain.linearRampToValueAtTime(0, t + (immediate ? 0.02 : 0.25));
  try { src.stop(t + (immediate ? 0.03 : 0.3)); } catch {}
}

async function wakeLock(on) {
  try {
    if (on && 'wakeLock' in navigator) A.wake = await navigator.wakeLock.request('screen');
    else if (!on && A.wake) { await A.wake.release(); A.wake = null; }
  } catch {}
}

// ---------------- Level meter ----------------

const meterState = { peakHold: 0, rmsDb: -120, clip: false };
function startMeter() {
  const buf = new Float32Array(A.meter.fftSize);
  const tick = () => {
    if (!A.meter) return;
    A.meter.getFloatTimeDomainData(buf);
    let s = 0, pk = 0;
    for (let i = 0; i < buf.length; i++) { s += buf[i] * buf[i]; pk = Math.max(pk, Math.abs(buf[i])); }
    const rmsDb = 10 * Math.log10(s / buf.length + 1e-12);
    meterState.rmsDb = rmsDb;
    if (pk > 0.97) meterState.clip = true;
    const pct = Math.max(0, Math.min(100, ((rmsDb + 70) / 70) * 100));
    $('#meterBar').style.width = pct + '%';
    $('#meterText').textContent = pk > 0.97 ? 'Too loud: mic is clipping' : `Mic ${rmsDb.toFixed(0)} dBFS`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------- Plot ----------------

function drawPlot(canvas, series, { yMin = -20, yMax = 15 } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const padL = 30, padB = 18, padT = 6, padR = 6;
  const X = (f) => padL + ((Math.log(f / 20) / Math.log(1000)) * (w - padL - padR));
  const Y = (db) => padT + ((yMax - db) / (yMax - yMin)) * (h - padT - padB);
  g.font = '10px -apple-system, sans-serif'; g.fillStyle = '#5c6778'; g.strokeStyle = '#1e242e'; g.lineWidth = 1;
  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    g.beginPath(); g.moveTo(X(f), padT); g.lineTo(X(f), h - padB); g.stroke();
    g.textAlign = 'center'; g.fillText(f >= 1000 ? f / 1000 + 'k' : f, X(f), h - 5);
  }
  for (let db = Math.ceil(yMin / 5) * 5; db <= yMax; db += 5) {
    g.strokeStyle = db === 0 ? '#323b49' : '#1e242e';
    g.beginPath(); g.moveTo(padL, Y(db)); g.lineTo(w - padR, Y(db)); g.stroke();
    g.textAlign = 'right'; g.fillText(db, padL - 4, Y(db) + 3);
  }
  for (const s of series) {
    if (!s.data) continue;
    g.lineWidth = s.width || 2; g.setLineDash(s.dash || []);
    let pen = false, lastOk = null;
    for (let i = 0; i < FREQS.length; i++) {
      const ok = !s.valid || s.valid[i];
      if (ok !== lastOk) {
        if (pen) g.stroke();
        g.beginPath(); g.strokeStyle = ok ? s.color : '#3a4250'; pen = false;
        if (i > 0) { g.moveTo(X(FREQS[i - 1]), Y(clampY(s.data[i - 1]))); pen = true; }
        lastOk = ok;
      }
      const x = X(FREQS[i]), y = Y(clampY(s.data[i]));
      if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
    }
    if (pen) g.stroke();
  }
  g.setLineDash([]);
  function clampY(v) { return Math.max(yMin - 2, Math.min(yMax + 2, v)); }
}

// ---------------- Measurement ----------------

let running = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setStatus(msg, cls = '') { const el = $('#status'); el.textContent = msg; el.className = 'status ' + cls; }

function normalize(resp, valid) {
  let s = 0, n = 0;
  for (let i = 0; i < FREQS.length; i++) if (FREQS[i] >= 300 && FREQS[i] <= 3000 && valid[i]) { s += resp[i]; n++; }
  const off = n ? s / n : D.meanIn(FREQS, resp, 300, 3000);
  return resp.map((v) => v - off);
}

/** Accumulate analyser power spectra for `ms` milliseconds. */
async function capture(ms, onFrame) {
  const bins = A.an.frequencyBinCount, frame = new Float32Array(bins), acc = new Float64Array(bins);
  let frames = 0;
  const hop = Math.max(60, (A.an.fftSize / A.ctx.sampleRate) * 1000 / 4);
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (running?.cancel) break;
    A.an.getFloatFrequencyData(frame);
    if (Number.isFinite(frame[100])) {
      for (let k = 0; k < bins; k++) acc[k] += Math.pow(10, frame[k] / 10);
      frames++;
      onFrame?.(acc, frames);
    }
    await sleep(hop);
  }
  if (frames) for (let k = 0; k < bins; k++) acc[k] /= frames;
  return { power: acc, frames };
}

async function startMeasurement() {
  if (running) { running.cancel = true; return; }
  const btn = $('#startBtn');
  const internal = state.ui.source === 'internal';
  const secs = +$('#durSelect').value;
  running = { cancel: false };
  btn.textContent = 'Cancel'; btn.classList.add('running');
  try {
    ensureCtx();
    if (internal) getBuffer(state.ui.channel); // build the noise inside the tap gesture
    setStatus('Starting microphone…');
    await ensureMic();
    await wakeLock(true);
    meterState.clip = false;

    let noise = null;
    if (internal) {
      setStatus('Listening to background noise. Stay quiet… (2 s)');
      await sleep(400);
      noise = await capture(2000);
      if (running.cancel) throw new Error('cancelled');
      play(state.ui.channel, state.ui.level);
      setStatus('Playing pink noise, waiting for it to settle…');
      await sleep(1500);
    } else {
      setStatus('Make sure the pink noise is already playing on the other device. Starting in 2 s…');
      await sleep(2000);
    }
    if (running.cancel) throw new Error('cancelled');
    meterState.clip = false;
    const t0 = performance.now();
    const live = (acc, frames) => {
      const tmp = acc.map((v) => v / frames);
      const resp = D.powerToResponse(tmp, FREQS, A.map);
      const allOk = new Array(FREQS.length).fill(true);
      drawMeasure(normalize(resp, allOk));
      const left = Math.max(0, secs - (performance.now() - t0) / 1000);
      setStatus(`Measuring… ${left.toFixed(0)} s left. Hold still.`);
    };
    const sig = await capture(secs * 1000, live);
    if (internal) stopPlay();
    if (running.cancel) throw new Error('cancelled');
    if (sig.frames < 3) throw new Error('No audio frames captured. Check mic permission.');

    const resp = D.powerToResponse(sig.power, FREQS, A.map);
    let valid = new Array(FREQS.length).fill(true);
    let snrNote = '';
    if (noise && noise.frames) {
      const nresp = D.powerToResponse(noise.power, FREQS, A.map);
      valid = resp.map((v, i) => v - nresp[i] >= 10);
      const mid = FREQS.reduce((a, f, i) => a + (f >= 200 && f <= 5000 && valid[i] ? 1 : 0), 0);
      const midAll = FREQS.filter((f) => f >= 200 && f <= 5000).length;
      if (mid < midAll * 0.8) snrNote = 'Signal is barely above the background noise. Turn the volume up and measure again.';
    } else if (meterState.rmsDb < -55) {
      snrNote = 'The level was very low. Is the signal playing? Turn the volume up.';
    }
    const p = prof();
    const m = {
      id: uid(), name: $('#posName').value.trim() || `Position ${p.measurements.length + 1}`,
      date: Date.now(), use: true,
      resp: Array.from(normalize(resp, valid), (v) => Math.round(v * 100) / 100),
      valid: valid.map((v) => (v ? 1 : 0)),
    };
    p.measurements.push(m);
    save();
    bumpPosName();
    renderMeasureList(); drawMeasure(); renderEq();
    if (meterState.clip) setStatus('Saved, but the mic clipped (too loud). Lower the volume and measure again for accuracy.', 'warn');
    else if (snrNote) setStatus('Saved. ' + snrNote, 'warn');
    else setStatus(`Saved "${m.name}". Move the phone ~10 cm and measure again, or open the EQ tab.`, 'good');
  } catch (e) {
    stopPlay();
    if (e.message === 'cancelled') setStatus('Cancelled.');
    else if (e.name === 'NotAllowedError') setStatus('Microphone permission denied. Allow it in Settings → Safari → Microphone, then reload.', 'bad');
    else setStatus('Error: ' + e.message, 'bad');
    drawMeasure();
  } finally {
    running = null; await wakeLock(false);
    btn.textContent = 'Start measurement'; btn.classList.remove('running');
  }
}

function bumpPosName() {
  const el = $('#posName');
  const m = el.value.match(/^(.*?)(\d+)$/);
  el.value = m ? m[1] + (+m[2] + 1) : el.value + ' 2';
}

function drawMeasure(liveResp) {
  const p = prof();
  const series = p.measurements.map((m, i) => m.use ? { data: m.resp, valid: m.valid, color: COLORS[i % COLORS.length], width: 1.5 } : null).filter(Boolean);
  const avg = average(p);
  if (avg && p.measurements.filter((m) => m.use).length > 1) series.push({ data: avg.resp, valid: avg.valid, color: '#ffffff', width: 2.5 });
  if (liveResp) series.push({ data: liveResp, color: '#4ade80', width: 2.5 });
  drawPlot($('#measurePlot'), series);
  $('#measureLegend').innerHTML = (liveResp ? '<span><i style="background:#4ade80"></i>Live</span>' : '') +
    (series.length > 1 && !liveResp ? '<span><i style="background:#fff"></i>Average</span>' : '') +
    '<span><i style="background:#3a4250"></i>Too close to background noise</span>';
}

function renderMeasureList() {
  const p = prof(), ul = $('#measList');
  $('#measCount').textContent = p.measurements.length ? `(${p.measurements.filter((m) => m.use).length} used)` : '';
  ul.innerHTML = p.measurements.length ? '' : '<li class="hint">None yet.</li>';
  p.measurements.forEach((m, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<input type="checkbox" ${m.use ? 'checked' : ''}><span class="sw" style="background:${COLORS[i % COLORS.length]}"></span>
      <div class="grow">${esc(m.name)}<small>${new Date(m.date).toLocaleString()}</small></div><button>Delete</button>`;
    li.querySelector('input').onchange = (e) => { m.use = e.target.checked; save(); renderMeasureList(); drawMeasure(); renderEq(); };
    li.querySelector('button').onclick = () => {
      if (!confirm(`Delete "${m.name}"?`)) return;
      p.measurements.splice(i, 1); save(); renderMeasureList(); drawMeasure(); renderEq();
    };
    ul.appendChild(li);
  });
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function average(p) {
  const ms = p.measurements.filter((m) => m.use);
  if (!ms.length) return null;
  const resp = new Float64Array(FREQS.length), valid = new Array(FREQS.length);
  for (let i = 0; i < FREQS.length; i++) {
    let s = 0, n = 0;
    for (const m of ms) if (m.valid[i]) { s += m.resp[i]; n++; }
    if (n === 0) { for (const m of ms) s += m.resp[i]; resp[i] = s / ms.length; valid[i] = false; }
    else { resp[i] = s / n; valid[i] = n >= Math.ceil(ms.length / 2); }
  }
  return { resp, valid };
}

// ---------------- EQ ----------------

function computeEq(p) {
  const avg = average(p);
  if (!avg) return null;
  const target = D.targetCurve(FREQS, p.target, p.bass, p.treble);
  const autoLow = D.autoLowLimit(FREQS, avg.resp);
  const low = p.low || autoLow;
  const high = p.high || 14000;
  const w = Float64Array.from(FREQS, (f, i) => (avg.valid[i] && f >= low && f <= high ? (f > 10000 ? 0.5 : 1) : 0));
  if (w.reduce((a, b) => a + b, 0) < 10) return { avg, target, low, autoLow, empty: true };
  const { err, offset } = D.correctionNeeded(FREQS, avg.resp, target, w, { maxBoost: p.maxBoost, maxCut: 12 });
  const aligned = avg.resp.map((v) => v - offset);
  const spotify = D.fitGraphic(FREQS, err, w, SPOTIFY_BANDS, { min: -12, max: Math.min(12, p.maxBoost), step: 0.5 });
  const apo = D.fitParametric(FREQS, err, w, { maxBoost: p.maxBoost, maxCut: 12, fLo: Math.max(20, low * 0.8), fHi: Math.min(20000, high * 1.2) });
  const c = p.car;
  const car = D.fitGraphic(FREQS, err, w, c.bands, { min: c.min, max: Math.min(c.max, p.maxBoost), step: c.step || 1 });
  return { avg, aligned, target, low, autoLow, w, err, spotify, apo, car };
}

let lastEq = null;
function renderEq() {
  const p = prof();
  const r = (lastEq = computeEq(p));
  $('#eqEmpty').style.display = r && !r.empty ? 'none' : 'block';
  if (r?.empty) $('#eqEmpty').textContent = 'Not enough clean data in the measurement. Measure again louder.';
  else $('#eqEmpty').textContent = 'Take a measurement first (Measure tab).';
  $('#lowHint').textContent = r ? `Auto-detected bass limit: ${Math.round(r.autoLow)} Hz. Below this the speaker can't play much, so we don't try to boost it.` : '';
  if (!r || r.empty) {
    drawPlot($('#eqPlot'), r ? [{ data: r.avg.resp, valid: r.avg.valid, color: '#8b97a8' }, { data: r.target, color: '#f5c542', dash: [5, 4] }] : []);
    $('#spotifyBars').innerHTML = $('#carBars').innerHTML = '';
    $('#apoText').textContent = '(no measurement yet)';
    return;
  }
  const pred = state.ui.pred;
  const eqc = pred === 'apo' ? r.apo.curve : pred === 'car' ? r.car.curve : r.spotify.curve;
  const after = r.aligned.map((v, i) => v + eqc[i]);
  drawPlot($('#eqPlot'), [
    { data: r.aligned, valid: r.avg.valid, color: '#8b97a8', width: 1.5 },
    { data: r.target, color: '#f5c542', width: 1.5, dash: [5, 4] },
    { data: after, valid: r.avg.valid, color: '#4ade80', width: 2.5 },
  ]);
  renderBars($('#spotifyBars'), r.spotify.bands, 12);
  const pre = Math.max(...r.spotify.bands.map((b) => b.gain));
  $('#spotifyNote').textContent = (pre > 0 ? `Boosts can make loud songs distort. If you hear crackling, lower all sliders by ${pre} dB. ` : '') +
    "Spotify doesn't publish the exact shape of its sliders, so treat these as a very good starting point and fine-tune by ear.";
  $('#apoText').textContent = D.apoConfig(r.apo, `Speaker Tuner: ${p.name}`);
  const c = p.car;
  renderBars($('#carBars'), r.car.bands, Math.max(Math.abs(c.min), Math.abs(c.max)));
}

function renderBars(el, bands, range) {
  el.innerHTML = '';
  for (const b of bands) {
    const d = document.createElement('div'); d.className = 'bar';
    const h = Math.min(50, (Math.abs(b.gain) / range) * 50);
    const fill = b.gain >= 0 ? `bottom:50%;height:${h}%` : `top:50%;height:${h}%`;
    d.innerHTML = `<div class="track"><div class="fill ${b.gain >= 0 ? 'pos' : 'neg'}" style="${fill}"></div></div>
      <b>${b.gain > 0 ? '+' : ''}${fmtGain(b.gain)}</b><span>${b.fc >= 1000 ? +(b.fc / 1000).toFixed(1) + 'k' : b.fc}</span>`;
    el.appendChild(d);
  }
}
const fmtGain = (g) => (Number.isInteger(g) ? g : g.toFixed(1));

// ---------------- UI wiring ----------------

function seg(sel, value, onChange) {
  const el = $(sel);
  const set = (v) => $$(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  set(value);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    set(b.dataset.v); onChange(b.dataset.v);
  });
}

function renderProfileSelect() {
  $('#profileSelect').innerHTML = state.profiles.map((p) => `<option value="${p.id}" ${p.id === state.current ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}
function renderProfiles() {
  const ul = $('#profileList'); ul.innerHTML = '';
  for (const p of state.profiles) {
    const li = document.createElement('li');
    li.innerHTML = `<input type="radio" name="prof" ${p.id === state.current ? 'checked' : ''}>
      <div class="grow">${esc(p.name)}<small>${p.kind} · ${p.measurements.length} measurement(s)</small></div>
      <button data-a="ren">Rename</button><button data-a="del">Delete</button>`;
    li.querySelector('input').onchange = () => selectProfile(p.id);
    li.querySelector('[data-a=ren]').onclick = () => {
      const n = prompt('Profile name', p.name); if (!n) return;
      p.name = n.trim(); save(); renderProfiles(); renderProfileSelect();
    };
    li.querySelector('[data-a=del]').onclick = () => {
      if (state.profiles.length === 1) return toast('Keep at least one profile');
      if (!confirm(`Delete profile "${p.name}" and its measurements?`)) return;
      state.profiles = state.profiles.filter((x) => x !== p);
      if (state.current === p.id) state.current = state.profiles[0].id;
      save(); selectProfile(state.current);
    };
    ul.appendChild(li);
  }
}
function selectProfile(id) {
  state.current = id; save();
  renderProfileSelect(); renderProfiles(); loadProfileControls(); renderMeasureList(); drawMeasure(); renderEq();
}

function loadProfileControls() {
  const p = prof();
  $('#targetSelect').value = p.target;
  $('#bassSlider').value = p.bass; $('#trebleSlider').value = p.treble; $('#boostSlider').value = p.maxBoost;
  $('#lowInput').value = p.low || ''; $('#highInput').value = p.high || 14000;
  $('#carPreset').value = p.car.preset; $('#carBands').value = p.car.bands.join(', ');
  $('#carMin').value = p.car.min; $('#carMax').value = p.car.max; $('#carStep').value = p.car.step;
  updateLabels();
}
function updateLabels() {
  const p = prof(), sg = (v) => (v > 0 ? '+' : '') + v + ' dB';
  $('#bassVal').textContent = sg(+p.bass); $('#trebleVal').textContent = sg(+p.treble);
  $('#boostVal').textContent = '+' + p.maxBoost + ' dB';
  $('#levelVal').textContent = state.ui.level + ' dB';
  $('#genLevelVal').textContent = $('#genLevel').value + ' dB';
}

function init() {
  // Tabs
  $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('nav.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'measure') drawMeasure();
    if (b.dataset.tab === 'eq') renderEq();
    if (b.dataset.tab === 'profiles') renderProfiles();
    window.scrollTo(0, 0);
  }));

  // Measure controls
  seg('#sourceSeg', state.ui.source, (v) => { state.ui.source = v; save(); $('#internalOpts').style.display = v === 'internal' ? '' : 'none'; });
  $('#internalOpts').style.display = state.ui.source === 'internal' ? '' : 'none';
  seg('#channelSeg', state.ui.channel, (v) => { state.ui.channel = v; save(); });
  $('#levelSlider').value = state.ui.level;
  $('#levelSlider').oninput = (e) => { state.ui.level = +e.target.value; save(); updateLabels(); setPlayLevel(state.ui.level); };
  $('#startBtn').onclick = startMeasurement;

  // EQ controls
  $('#targetSelect').innerHTML = Object.entries(D.TARGETS).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('');
  const bind = (sel, key, parse = Number, ev = 'input') => $(sel).addEventListener(ev, (e) => { prof()[key] = parse(e.target.value); save(); updateLabels(); renderEq(); });
  bind('#targetSelect', 'target', String, 'change');
  bind('#bassSlider', 'bass'); bind('#trebleSlider', 'treble'); bind('#boostSlider', 'maxBoost');
  bind('#lowInput', 'low', (v) => (v ? Math.max(20, Math.min(500, +v)) : null), 'change');
  bind('#highInput', 'high', (v) => Math.max(2000, Math.min(20000, +v || 14000)), 'change');
  seg('#predSeg', state.ui.pred, (v) => { state.ui.pred = v; save(); renderEq(); });

  $('#carPreset').onchange = (e) => {
    const c = prof().car; c.preset = e.target.value;
    if (CAR_PRESETS[c.preset]) c.bands = CAR_PRESETS[c.preset].slice();
    $('#carBands').value = c.bands.join(', '); save(); renderEq();
    if (c.preset === 'custom') $('#carBands').focus();
  };
  $('#carBands').onchange = (e) => {
    const bands = e.target.value.split(/[ ,;]+/).map((s) => parseFloat(s.replace(/k$/i, '')) * (/k$/i.test(s) ? 1000 : 1))
      .filter((f) => f >= 20 && f <= 20000).sort((a, b) => a - b);
    if (bands.length < 2) return toast('Enter at least 2 frequencies, e.g. 60, 250, 1k, 4k, 12k');
    const c = prof().car; c.bands = bands; c.preset = 'custom'; $('#carPreset').value = 'custom';
    $('#carBands').value = bands.join(', '); save(); renderEq();
  };
  for (const [sel, key] of [['#carMin', 'min'], ['#carMax', 'max'], ['#carStep', 'step']]) {
    $(sel).onchange = (e) => { prof().car[key] = +e.target.value; save(); renderEq(); };
  }

  $('#apoCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('#apoText').textContent); toast('Copied'); } catch { toast('Copy failed. Long-press the text instead.'); }
  };
  $('#apoShare').onclick = async () => {
    const text = $('#apoText').textContent;
    if (navigator.share) { try { await navigator.share({ title: 'Equalizer APO config', text }); } catch {} }
    else { await navigator.clipboard?.writeText(text); toast('Sharing not supported here, so copied instead'); }
  };
  $('#apoDownload').onclick = () => download(new Blob([$('#apoText').textContent + '\n'], { type: 'text/plain' }), 'config.txt');

  // Signal generator
  $('#genLevel').oninput = () => { updateLabels(); setPlayLevel(+$('#genLevel').value); };
  $$('[data-gen]').forEach((b) => b.addEventListener('click', () => {
    setSession('playback');
    play(b.dataset.gen, +$('#genLevel').value);
    $$('[data-gen]').forEach((x) => x.classList.toggle('on', x === b));
    $('#genStatus').textContent = `Playing: ${b.textContent.replace(/\s+/g, ' ').trim()}`;
    wakeLock(true);
  }));
  $('#genStop').onclick = () => {
    stopPlay(); $$('[data-gen]').forEach((x) => x.classList.remove('on'));
    $('#genStatus').textContent = 'Nothing playing.'; wakeLock(false);
  };
  $('#dlPink').onclick = () => {
    const fs = 48000, n = 1 << 19, a = D.makePinkNoise(n, fs, { seed: 1, rms: 0.18 });
    const out = new Float32Array(fs * 60);
    for (let i = 0; i < out.length; i++) out[i] = a[i % n];
    download(new Blob([D.encodeWav(out, fs)], { type: 'audio/wav' }), 'pink-noise-60s.wav');
  };
  $('#dlSweep').onclick = () => download(new Blob([D.encodeWav(D.makeLogSweep(48000), 48000)], { type: 'audio/wav' }), 'sweep-20-20k.wav');

  // Profiles
  $('#profileSelect').onchange = (e) => selectProfile(e.target.value);
  $('#newProfBtn').onclick = () => {
    const name = $('#newProfName').value.trim(); if (!name) return toast('Enter a name');
    const p = newProfile(name, $('#newProfKind').value);
    state.profiles.push(p); $('#newProfName').value = ''; selectProfile(p.id); toast('Profile added');
  };
  $('#exportBtn').onclick = () => download(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }), 'speaker-tuner-backup.json');
  $('#importFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (!Array.isArray(s.profiles)) throw new Error('bad file');
      if (!confirm('Replace all current profiles with the imported ones?')) return;
      Object.assign(state, s); save(); selectProfile(state.current || state.profiles[0].id); toast('Imported');
    } catch { toast('That file is not a Speaker Tuner backup'); }
    e.target.value = '';
  };

  window.addEventListener('resize', () => { drawMeasure(); renderEq(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && A.ctx) A.ctx.resume().catch(() => {}); });

  selectProfile(state.current);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

init();
