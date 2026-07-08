// Triangle-wave audio preview for haptic events. Sharpness maps to pitch
// (the 80-230 Hz haptic range, scaled up for audibility on speakers/
// headphones), intensity maps to loudness. This is a *preview*, not a
// haptic playback - real device haptics need the .ahap file itself.

import { sharpnessToFreq } from "./ahap.js";

const AUDIO_FREQ_SCALE = 3.0; // 80-230 Hz -> ~240-690 Hz, audible on small speakers
const MASTER_GAIN = 0.35;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.activeNodes = [];
    this.scheduledTimeouts = [];
  }

  ensureContext() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  stopAll() {
    for (const t of this.scheduledTimeouts) clearTimeout(t);
    this.scheduledTimeouts = [];
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const node of this.activeNodes) {
      try {
        node.gain.gain.cancelScheduledValues(now);
        node.gain.gain.setValueAtTime(node.gain.gain.value, now);
        node.gain.gain.linearRampToValueAtTime(0, now + 0.02);
        node.osc.stop(now + 0.03);
      } catch (e) {
        /* already stopped */
      }
    }
    this.activeNodes = [];
  }

  /** Schedules one event (+ any curves that start at the same time) at
   * `startAt` seconds from now. Returns the event's audible duration. */
  _scheduleOne(item, curves, startAt) {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const t0 = now + Math.max(0, startAt);

    const osc = ctx.createOscillator();
    osc.type = "triangle";
    const baseFreq = sharpnessToFreq(item.sharpness) * AUDIO_FREQ_SCALE;
    osc.frequency.setValueAtTime(baseFreq, t0);

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0, t0);
    osc.connect(gainNode).connect(ctx.destination);

    const peak = Math.min(1, Math.max(0, item.intensity)) * MASTER_GAIN;

    let duration;
    if (item.kind === "transient") {
      duration = 0.12;
      const attack = item.attack ?? 0.002;
      const release = item.release ?? duration - attack;
      gainNode.gain.linearRampToValueAtTime(peak, t0 + Math.max(0.001, attack));
      gainNode.gain.linearRampToValueAtTime(0, t0 + Math.max(0.02, attack + release));
    } else {
      duration = Math.max(0.03, item.duration);
      const attack = Math.min(item.attack ?? duration * 0.1, duration * 0.5);
      const release = Math.min(item.release ?? duration * 0.2, duration * 0.5);
      const sustainEnd = Math.max(t0 + attack, t0 + duration - release);
      gainNode.gain.linearRampToValueAtTime(peak, t0 + Math.max(0.001, attack));
      gainNode.gain.setValueAtTime(peak, sustainEnd);
      gainNode.gain.linearRampToValueAtTime(0, t0 + duration);
    }

    // Apply any parameter curves that start together with this event.
    for (const curve of curves) {
      if (Math.abs(curve.time - item.time) > 1e-6) continue;
      for (const p of curve.points) {
        const at = t0 + p.time;
        if (curve.parameterId === "HapticSharpnessControl") {
          osc.frequency.linearRampToValueAtTime(sharpnessToFreq(p.value) * AUDIO_FREQ_SCALE, at);
        } else if (curve.parameterId === "HapticIntensityControl") {
          gainNode.gain.linearRampToValueAtTime(peak * Math.min(1, Math.max(0, p.value)), at);
        }
      }
    }

    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
    const node = { osc, gain: gainNode };
    this.activeNodes.push(node);
    osc.onended = () => {
      this.activeNodes = this.activeNodes.filter((n) => n !== node);
    };
    return duration;
  }

  /** Plays a single item in isolation, starting "now". */
  previewItem(item, allItems = []) {
    this.ensureContext();
    const curves = allItems.filter((it) => it.kind === "curve");
    this._scheduleOne(item, curves, 0);
  }

  /** Plays every event at-or-after `fromTime` (pattern seconds), preserving
   * relative timing. `onItemStart(item)` fires (roughly) when each item
   * begins playing, for screen-reader / visual-cursor sync. */
  playFrom(items, fromTime, onItemStart) {
    this.stopAll();
    this.ensureContext();
    const events = items.filter((it) => it.kind !== "curve" && it.time >= fromTime - 1e-9);
    const curves = items.filter((it) => it.kind === "curve");
    for (const item of events) {
      const delay = item.time - fromTime;
      this._scheduleOne(item, curves, delay);
      if (onItemStart) {
        const timeout = setTimeout(() => onItemStart(item), Math.max(0, delay * 1000));
        this.scheduledTimeouts.push(timeout);
      }
    }
    const last = events.reduce((max, it) => Math.max(max, it.time + (it.duration || 0.15) - fromTime), 0);
    return last;
  }
}
