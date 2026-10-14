# Speaker Tuner 🎙️🎚️

A web-based acoustic measurement and speaker correction tool designed for phones (iOS / Android) and desktop browsers. It turns your iPhone or smartphone into an acoustic measurement mic to measure room and speaker frequency response, and calculates tailored EQ settings for:
1. **Spotify built-in EQ** (6-band graphic EQ)
2. **Equalizer APO** (system-wide parametric EQ for Windows laptops / PCs)
3. **Car head units** (3-band, 5-band, 7-band, 10-band ISO, or custom graphic EQs)

---

## Features
- **PWA / Offline Support**: Installable directly onto iOS / Android home screens; runs offline in your car or outdoors via Service Workers.
- **Microphone Compensation & Noise Floor Safety**: Samples ambient background noise first, ignores low-SNR / noisy bands, and automatically caps boosts to protect small speaker drivers from over-excursion and distortion.
- **Built-in Audio Generator**:
  - Uncorrelated stereo pink noise (avoids comb filtering between left and right channels)
  - Isolated left / right channels
  - In-phase and out-of-phase polarity checks
  - Logarithmic sine sweep (20 Hz – 20 kHz)
  - Direct 16-bit WAV download option for USB thumb drives or head unit playback
- **Multi-Position Averaging**: Take multiple measurements across listening positions (e.g., driver's ear, passenger seat) to compute spatial average response.
- **Target Curves**:
  - Car (low-end boost to counter road noise, smooth treble)
  - Laptop (clean vocal range, gentle high cut, bass excursion protection)
  - Natural / Harman-style
  - Flat (studio / reference)
  - Custom bass / treble tilt controls

---

## How to Deploy to GitHub Pages

1. Push this repository to GitHub under your account (e.g. `https://github.com/BlaBla-03/speaker-tuner`).
2. In your GitHub repository:
   - Go to **Settings** > **Pages**.
   - Under **Build and deployment** > **Source**, select **Deploy from a branch**.
   - Select branch `main` (or `master`) and folder `/ (root)`.
   - Click **Save**.
3. In ~1 minute, GitHub will give you an HTTPS link:
   `https://<username>.github.io/<repo-name>/`
4. Open the link on your iPhone Safari, tap **Share** > **Add to Home Screen**.

---

## Testing & Architecture
- `dsp.js`: Pure mathematical DSP core (FFT, loopable pink noise generation, fractional-octave band mapping, RBJ biquads, coordinate descent graphic EQ fitter, greedy parametric EQ fitter).
- `app.js`: Web Audio API integration and mobile-responsive UI orchestration.
- `test/dsp.test.mjs`: Pure DSP unit test suite.
- `test/e2e.mjs`: Automated headless Chrome testing with simulated microphone hardware input.
