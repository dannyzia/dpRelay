# Device FPS probe — hero canvas (spec §12)

The recorded FPS numbers (headless desktop cadence, 4× CPU-throttled emulation)
are honest but are not a device. The physical-device number is the last open
§12 item and needs one run on a real phone (any Android Chrome on the same
Wi-Fi). Procedure:

## 1. Serve the site on the LAN

```bash
cd "<repo>/landing"
python3 -m http.server 8123 --bind 0.0.0.0
hostname -I   # use the first IP
```

Open `http://<LAN-IP>:8123/` on the phone.

## 2. Run the probe snippet

Android Chrome (USB debugging): `chrome://inspect` → inspect → Console → paste
the snippet below. (Without USB: any console mechanism works — the snippet is
paste-in only.)

```js
(async () => {
  const pin = document.querySelector('.hero-pin');
  const r = pin.getBoundingClientRect();
  const top = r.top + scrollY;
  const span = pin.offsetHeight - innerHeight;
  scrollTo({ top, behavior: 'instant' });
  const frames = [];
  let stop = false;
  (function loop(t) {
    frames.push(t);
    if (!stop) requestAnimationFrame(loop);
  })(performance.now());
  const t0 = frames[0];
  while (performance.now() - t0 < 9000) {
    const p = (performance.now() - t0) / 9000;
    scrollTo({ top: top + Math.round(p * span), behavior: 'instant' });
    await new Promise((res) => setTimeout(res, 30));
  }
  stop = true;
  const gaps = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i] - frames[i - 1]);
  const s = [...gaps].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  const p95 = s[Math.floor(s.length * 0.95)];
  const dropped = gaps.filter((g) => g > 34).length;
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;background:#111;color:#0f0;font:12px/1.6 monospace;padding:10px;border-radius:8px;white-space:pre';
  d.textContent = `frames=${frames.length} median=${med.toFixed(1)}ms p95=${p95.toFixed(1)}ms >34ms=${dropped}`;
  document.body.appendChild(d);
})();
```

The snippet auto-scrolls the full hero (p = 0 → 1) over ~9 s, samples every
rAF, and pins an overlay to the screen:

```
frames=NNN median=NN.Nms p95=NN.Nms >34ms=N
```

Report those four numbers back and they go into the §12 results. No data
leaves the device.
