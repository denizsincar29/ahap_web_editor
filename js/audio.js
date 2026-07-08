// Triangle-wave audio preview for haptic events. Sharpness maps to pitch
// (the 80-230 Hz haptic range, scaled up for audibility on speakers/
// headphones), intensity maps to loudness. This is a *preview*, not a
// haptic playback - real device haptics need the .ahap file itself.
//
// Parameter curves ('curve' and 'curveRegion' items) are treated as global
// modulation over whatever time window they cover, matching how real AHAP
// engines apply ParameterCurve - they aren't tied to one specific event's
// start time, they modulate anything playing during their span.

import { sharpnessToFreq } from "./ahap.js";

const AUDIO_FREQ_SCALE = 3.0; // 80-230 Hz -> ~240-690 Hz, audible on small speakers
const MASTER_GAIN = 0.35;

/** Flattens every 'curve' and 'curveRegion' item into absolute-time point
 * lists per parameter, sorted by time. */
function flattenCurvePoints(items) {
  const sharpness = [];
  const intensity = [];
  for (const it of items) {
    if (it.kind === "curve") {
      const target = it.parameterId === "HapticIntensityControl" ? intensity : sharpness;
      for (const p of it.points) target.push({ tAbs: it.time + p.time, value: p.value });
    } else if (it.kind === "curveRegion") {
      for (const p of it.sharpnessPoints || []) sharpness.push({ tAbs: it.time + p.time, value: p.value });
      for (const p of it.intensityPoints || []) intensity.push({ tAbs: it.time + p.time, value: p.value });
    }
  }
  sharpness.sort((a, b) => a.tAbs - b.tAbs);
  intensity.sort((a, b) => a.tAbs - b.tAbs);
  return { sharpness, intensity };
}

function pointsWithin(list, start, end) {
  return list.filter((p) => p.tAbs >= start - 1e-9 && p.tAbs <= end + 1e-9);
}

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

  _scheduleOne(item, curvePoints, startAt) {
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

      if (curvePoints) {
        const sPts = pointsWithin(curvePoints.sharpness, item.time, item.time + duration);
        for (const p of sPts) osc.frequency.linearRampToValueAtTime(sharpnessToFreq(p.value) * AUDIO_FREQ_SCALE, t0 + (p.tAbs - item.time));
        const iPts = pointsWithin(curvePoints.intensity, item.time, item.time + duration);
        for (const p of iPts) gainNode.gain.linearRampToValueAtTime(peak * Math.min(1, Math.max(0, p.value)), t0 + (p.tAbs - item.time));
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

  _previewCurveAlone(item) {
    const ctx = this.ensureContext();
    const t0 = ctx.currentTime;
    const duration =
      item.kind === "curveRegion"
        ? Math.max(0.05, item.endTime - item.time)
        : Math.max(0.05, item.points.length ? item.points[item.points.length - 1].time : 0.3);

    const osc = ctx.createOscillator();
    osc.type = "triangle";
    const gainNode = ctx.createGain();
    osc.connect(gainNode).connect(ctx.destination);

    const baseGain = 0.6 * MASTER_GAIN;
    osc.frequency.setValueAtTime(sharpnessToFreq(0.5) * AUDIO_FREQ_SCALE, t0);
    gainNode.gain.setValueAtTime(baseGain, t0);

    const sharpnessPts = item.kind === "curveRegion" ? item.sharpnessPoints : item.parameterId === "HapticSharpnessControl" ? item.points : [];
    const intensityPts = item.kind === "curveRegion" ? item.intensityPoints : item.parameterId === "HapticIntensityControl" ? item.points : [];
    for (const p of sharpnessPts) osc.frequency.linearRampToValueAtTime(sharpnessToFreq(p.value) * AUDIO_FREQ_SCALE, t0 + p.time);
    for (const p of intensityPts) gainNode.gain.linearRampToValueAtTime(baseGain * Math.min(1, Math.max(0, p.value)), t0 + p.time);

    gainNode.gain.linearRampToValueAtTime(0, t0 + duration + 0.05);
    osc.start(t0);
    osc.stop(t0 + duration + 0.1);
    const node = { osc, gain: gainNode };
    this.activeNodes.push(node);
    osc.onended = () => {
      this.activeNodes = this.activeNodes.filter((n) => n !== node);
    };
  }

  previewItem(item, allItems = []) {
    this.ensureContext();
    if (item.kind === "curve" || item.kind === "curveRegion") {
      this._previewCurveAlone(item);
      return;
    }
    const curvePoints = flattenCurvePoints(allItems);
    this._scheduleOne(item, curvePoints, 0);
  }

  playFrom(items, fromTime, onItemStart) {
    this.stopAll();
    this.ensureContext();
    const events = items.filter((it) => it.kind !== "curve" && it.kind !== "curveRegion" && it.time >= fromTime - 1e-9);
    const curvePoints = flattenCurvePoints(items);
    for (const item of events) {
      const delay = item.time - fromTime;
      this._scheduleOne(item, curvePoints, delay);
      if (onItemStart) {
        const timeout = setTimeout(() => onItemStart(item), Math.max(0, delay * 1000));
        this.scheduledTimeouts.push(timeout);
      }
    }
    const last = events.reduce((max, it) => Math.max(max, it.time + (it.duration || 0.15) - fromTime), 0);
    return last;
  }
}
