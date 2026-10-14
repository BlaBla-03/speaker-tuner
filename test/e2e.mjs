// End-to-end test: headless Chrome + fake microphone fed with pink noise coloured by a
// known "speaker" curve. Drives the real UI via the DevTools protocol, checks the measured
// curve and the EQ, and saves phone-sized screenshots.
// Usage: node test/e2e.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as D from '../dsp.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const out = path.join(root, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// 1) Fake mic WAV: pink noise through a laptop-like speaker curve
const SPEAKER = [{ fc: 150, gain: -14, q: 0.6 }, { fc: 1000, gain: 6, q: 2 }, { fc: 4000, gain: -5, q: 1.5 }, { fc: 9000, gain: 4, q: 1 }];
const fsr = 48000, N = 1 << 19;
const pink = D.makePinkNoise(N, fsr, { seed: 3, rms: 0.1 });
const re = Float64Array.from(pink), im = new Float64Array(N);
D.fft(re, im);
for (let k = 1; k < N / 2; k++) {
  let db = 0; for (const p of SPEAKER) db += D.peakingDb((k * fsr) / N, p.fc, p.gain, p.q, fsr);
  const g = 10 ** (db / 20); re[k] *= g; im[k] *= g; re[N - k] = re[k]; im[N - k] = -im[k];
}
D.fft(re, im, true);
const sig = new Float32Array(fsr * 30);
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(re[i]));
for (let i = 0; i < sig.length; i++) sig[i] = (re[i % N] / peak) * 0.5;
const wavPath = path.join(out, 'fake-mic.wav');
fs.writeFileSync(wavPath, Buffer.from(D.encodeWav(sig, fsr)));

// 2) Static server
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(8123);

// 3) Chrome
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--no-first-run',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`,
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, msgId = 0; const pending = new Map(); const logs = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9333/json')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r)); break; }
    } catch {}
    await sleep(200);
  }
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`[console.${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('[EXCEPTION] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  };
}
const send = (method, params = {}) => new Promise((r) => { const id = ++msgId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })).result?.result?.value;
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(out, name), Buffer.from(r.result.data, 'base64')); };

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) fails++; };

try {
  await connect();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Browser.grantPermissions', { origin: 'http://localhost:8123', permissions: ['audioCapture'] }).catch(() => {});
  await send('Page.navigate', { url: 'http://localhost:8123/' });
  await sleep(1500);
  check('app loaded', await evalJs(`!!document.querySelector('#startBtn')`));

  // External source (the fake mic already "hears" the speaker), 5 s measurement
  await evalJs(`document.querySelector('#sourceSeg [data-v=external]').click(); document.querySelector('#durSelect').value='5'; document.querySelector('#posName').value='Seat 1'; document.querySelector('#startBtn').click(); true`);
  await sleep(4500);
  await shot('1-measuring.png');
  for (let i = 0; i < 30 && (await evalJs(`document.querySelector('#startBtn').textContent`)) !== 'Start measurement'; i++) await sleep(500);
  const status = await evalJs(`document.querySelector('#status').textContent`);
  console.log('status:', status);
  const m = await evalJs(`JSON.parse(localStorage.getItem('speakerTuner.v1')).profiles[0].measurements`);
  check('measurement saved', Array.isArray(m) && m.length === 1);

  if (m?.length) {
    const freqs = D.logFreqs(256);
    const truth = D.eqCurve(freqs, SPEAKER, fsr);
    const tref = D.meanIn(freqs, truth, 300, 3000);
    let maxErr = 0, at = 0;
    for (let i = 0; i < 256; i++) if (freqs[i] > 60 && freqs[i] < 14000) {
      const e = Math.abs(m[0].resp[i] - (truth[i] - tref)); if (e > maxErr) { maxErr = e; at = freqs[i]; }
    }
    check('browser-measured curve matches the fake speaker', maxErr < 3, `max err ${maxErr.toFixed(2)} dB @ ${at.toFixed(0)} Hz`);
  }

  // Second position, then EQ tab
  await evalJs(`document.querySelector('#startBtn').click(); true`);
  for (let i = 0; i < 30; i++) { await sleep(500); if ((await evalJs(`JSON.parse(localStorage.getItem('speakerTuner.v1')).profiles[0].measurements.length`)) === 2) break; }
  await sleep(300);
  await shot('2-measure-tab.png');
  await evalJs(`document.querySelector('nav [data-tab=eq]').click(); true`);
  await sleep(500);
  await shot('3-eq-spotify.png');
  const apo = await evalJs(`document.querySelector('#apoText').textContent`);
  console.log(apo);
  check('APO config generated', /Preamp: -?\d/.test(apo) && /Filter 1: ON PK/.test(apo));
  const spot = await evalJs(`[...document.querySelectorAll('#spotifyBars .bar b')].map(b=>b.textContent).join(' ')`);
  console.log('Spotify:', spot);
  check('Spotify bars rendered', spot.split(' ').length === 6);
  await evalJs(`document.querySelector('#predSeg [data-v=apo]').click(); window.scrollTo(0,0); true`);
  await sleep(300);
  await shot('4-eq-apo.png');
  await evalJs(`document.querySelector('nav [data-tab=signal]').click(); true`);
  await sleep(300);
  await shot('5-signal.png');
  // Generator smoke test: play and stop without errors
  await evalJs(`document.querySelector('[data-gen=both]').click(); true`);
  await sleep(800);
  check('generator playing', (await evalJs(`document.querySelector('#genStatus').textContent`)).startsWith('Playing'));
  await evalJs(`document.querySelector('#genStop').click(); true`);
  await evalJs(`document.querySelector('nav [data-tab=help]').click(); true`);
  await sleep(300);
  await shot('6-help.png');

  const errs = logs.filter((l) => /EXCEPTION|console.error/.test(l));
  if (logs.length) console.log(logs.join('\n'));
  check('no JS errors', errs.length === 0);
} catch (e) {
  console.error(e); fails++;
} finally {
  ws?.close(); chrome.kill(); server.close();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
}
