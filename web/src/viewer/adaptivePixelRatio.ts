/** Raises spatial sampling in an opted-in scene while the foreground frame cadence allows it. */
export class AdaptivePixelRatio {
  private native = 1;
  private target = 1;
  private boosted = false;
  private previous = NaN;
  private elapsed = 0;
  private frames = 0;
  private late = 0;
  private referenceMs = 1000 / 60;
  private retryAt = 0;

  configure(enabled: boolean, native: number, width: number, height: number): number | undefined {
    // The 1.5× route was measured at 1390×747. Bound additional framebuffer storage on larger displays.
    const canBoost = enabled && native === 1 && width * height * 2.25 <= 2_400_000;
    const target = canBoost ? 1.5 : native;
    if (this.native === native && this.target === target) return;
    const old = this.boosted ? this.target : this.native;
    this.native = native;
    this.target = target;
    this.retryAt = 0;
    this.resetWindow();
    this.boosted = false;
    return old === native ? undefined : native;
  }

  frame(now: number, visible: boolean): number | undefined {
    if (this.native === this.target) return;
    const delta = now - this.previous;
    this.previous = now;
    if (!visible || delta > 100) {
      this.resetWindow();
      if (this.boosted) return this.lower(now);
      return;
    }
    if (!(delta > 0)) return;
    this.elapsed += delta;
    this.frames++;
    const lateMs = this.boosted ? Math.min(20, this.referenceMs * 1.25) : 20;
    if (delta > lateMs) this.late++;
    if (this.elapsed < (this.boosted ? 600 : 1300)) return;

    const average = this.elapsed / this.frames;
    const lateFraction = this.late / this.frames;
    this.resetWindow();
    if (this.boosted) {
      if (average > this.referenceMs / 0.9 || lateFraction > 0.13) return this.lower(now);
    } else if (now >= this.retryAt && average < 1000 / 57 && lateFraction < 0.05) {
      this.referenceMs = average;
      this.boosted = true;
      return this.target;
    }
  }

  private resetWindow(): void {
    this.previous = NaN;
    this.elapsed = 0;
    this.frames = 0;
    this.late = 0;
  }

  private lower(now: number): number {
    this.boosted = false;
    this.retryAt = now + 6000;
    return this.native;
  }
}
