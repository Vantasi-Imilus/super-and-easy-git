// Sliding-window throughput meter shared by the HTTP and big-file modes.
export class SpeedMeter {
  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  add(totalBytes, now = Date.now()) {
    this.samples.push([now, totalBytes]);
    while (this.samples.length > 1 && now - this.samples[0][0] > this.windowMs) this.samples.shift();
  }

  reset() {
    this.samples = [];
  }

  rate(now = Date.now()) {
    if (this.samples.length < 2) return null;
    const [t0, b0] = this.samples[0];
    const [t1, b1] = this.samples[this.samples.length - 1];
    const dt = (t1 - t0) / 1000;
    if (dt <= 0 || t1 === t0) return null;
    return Math.max(0, (b1 - b0) / dt);
  }
}
