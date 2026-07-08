import {
  makeTransient,
  makeContinuous,
  makeCurveRegion,
  cloneItem,
  sortItems,
  itemEndTime,
  noteFreq,
  freqToSharpness,
  FREQ_MIN,
  FREQ_MAX,
} from "./ahap.js";
import { AudioEngine } from "./audio.js";

const DRUM_LABELS = {
  k: { name: "kick", shape: "punch", sharpness: 0.3 },
  t: { name: "tom", shape: "punch", sharpness: 0.4 },
  s: { name: "snare", shape: "hit", sharpness: 0.6 },
  h: { name: "closed hi-hat", shape: "hit", sharpness: 0.75 },
  x: { name: "clap", shape: "hit", sharpness: 0.7 },
  o: { name: "open hi-hat", shape: "ring", sharpness: 0.65 },
  c: { name: "crash", shape: "ring", sharpness: 0.6 },
  r: { name: "ride", shape: "ring", sharpness: 0.55 },
};
const DENOM_NAME = { 1: "whole", 2: "half", 4: "quarter", 8: "eighth", 16: "sixteenth", 32: "thirtysecond" };
const KEY_TO_DENOM = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16, 6: 32 };
// Zoom levels 1-9 while in bar/beat time mode, expressed as a fraction of
// one beat (levels 1-2 are fractions of a whole bar instead).
const ZOOM_LABEL = {
  1: "1 bar",
  2: "half bar",
  3: "1 beat",
  4: "half beat",
  5: "beat triplet",
  6: "quarter beat",
  7: "beat sixth",
  8: "eighth beat",
  9: "sixteenth beat",
};

const SHORTCUT_SUMMARY = [
  ["Left / Right", "move time cursor by one step"],
  ["Ctrl+Left / Ctrl+Right", "select previous / next item"],
  ["[ / ]", "halve / double the time step"],
  ["Home / End", "cursor to start / end of pattern"],
  ["N", "switch to Normal insert mode"],
  ["T (Normal mode)", "insert a transient at the cursor"],
  ["C ... C (Normal mode)", "start / close a continuous event"],
  ["Shift+C ... Shift+C", "start / close a curve region"],
  ["Shift+P", "add a curve point (popup: parameter + value)"],
  ["A / D / R (Normal mode)", "set attack / decay / release (popup)"],
  ["- (dash)", "set time signature + tempo, switch to bar/beat cursor"],
  ["1-9", "zoom (bar/beat mode) or note duration (melody/drums)"],
  ["A-G (Melody mode)", "insert a note; Shift = sharp, Alt = flat"],
  ["k t s h x o c r (Drums mode)", "insert a drum hit"],
  ["M", "mark range start/end (for track-scoped copy)"],
  ["Ctrl+C / Ctrl+V", "copy selection or marked range / paste at cursor"],
  ["Up / Down", "nudge intensity; Shift+Up/Down nudges sharpness"],
  ["Enter", "open the full detail form for the selected item"],
  ["Delete / Backspace", "delete the selected item"],
  ["P", "preview the selected item"],
  ["Ctrl+Space", "play the whole pattern from the cursor"],
  ["Escape", "stop playback / cancel a popup / clear the range mark"],
  ["V", "show only the active track's items"],
  ["H", "this shortcuts popup"],
];

export class Editor {
  constructor(dom) {
    this.dom = dom;
    this.items = [];
    this.selectedId = null;
    this.cursorTime = 0;
    this.timeStep = 0.05;
    this.mode = "melody";
    this.octave = 4;
    this.durationDenom = 8;
    this.pendingAccent = false;
    this.clipboard = null;
    this.audio = new AudioEngine();

    // two-stage insert state
    this.openContinuousId = null;
    this.openCurveRegionId = null;

    // bar/beat time mode
    this.timeMode = "raw"; // 'raw' | 'bars'
    this.timeSig = { num: 4, den: 4 };
    this.zoomLevel = 3;

    // tracks (editor-only concept, merged together on .ahap export)
    this.tracks = [{ id: "track1", name: "Track 1" }];
    this.activeTrackId = "track1";
    this.soloTrack = false;

    // range mark for track-scoped copy
    this.rangeStart = null;
    this.rangeEnd = null;

    this._bindToolbar();
    this._bindListKeys();
    this._bindForm();
    this._bindPopup();
    this._bindTracks();
    this.render();
  }

  // ---- announcements -------------------------------------------------

  announce(msg) {
    const el = this.dom.liveStatus;
    el.textContent = "";
    requestAnimationFrame(() => {
      el.textContent = msg;
    });
  }

  alert(msg) {
    const el = this.dom.liveAlert;
    el.textContent = "";
    requestAnimationFrame(() => {
      el.textContent = msg;
    });
  }

  // ---- data helpers ----------------------------------------------------

  sorted() {
    return sortItems(this.items);
  }

  visibleItems() {
    const list = this.sorted();
    return this.soloTrack ? list.filter((it) => it.trackId === this.activeTrackId) : list;
  }

  selectedItem() {
    return this.items.find((it) => it.id === this.selectedId) || null;
  }

  selectedIndex() {
    const list = this.visibleItems();
    return list.findIndex((it) => it.id === this.selectedId);
  }

  patternEnd() {
    return this.items.reduce((max, it) => Math.max(max, itemEndTime(it)), 0);
  }

  trackName(id) {
    const t = this.tracks.find((t) => t.id === id);
    return t ? t.name : "?";
  }

  loadItems(items, { announceMsg, trackName } = {}) {
    let trackId = this.activeTrackId;
    if (trackName) {
      trackId = "track" + (this.tracks.length + 1) + "_" + Date.now().toString(36);
      this.tracks.push({ id: trackId, name: trackName });
      this.activeTrackId = trackId;
    }
    for (const it of items) if (!it.trackId) it.trackId = trackId;
    this.items = items;
    this.selectedId = items.length ? sortItems(items)[0].id : null;
    this.cursorTime = 0;
    this.render();
    if (announceMsg) this.announce(announceMsg);
  }

  // ---- selection / cursor ----------------------------------------------

  select(id, { moveCursor = true, quiet = false } = {}) {
    this.selectedId = id;
    const item = this.selectedItem();
    if (item && moveCursor) this.cursorTime = item.time;
    this.render();
    if (item && !quiet) this.announce(this.describeItem(item));
  }

  moveCursorBy(deltaSteps) {
    this.cursorTime = Math.max(0, this.cursorTime + deltaSteps * this.timeStep);
    this.render();
    this.announce(this.formatCursor());
  }

  moveSelectionAdjacent(direction) {
    const list = this.visibleItems();
    if (!list.length) {
      this.announce("no items");
      return;
    }
    let idx = this.selectedIndex();
    if (idx < 0) idx = direction > 0 ? -1 : list.length;
    idx += direction;
    if (idx < 0 || idx >= list.length) {
      this.announce(direction > 0 ? "end of pattern" : "start of pattern");
      return;
    }
    this.select(list[idx].id);
  }

  changeStep(factor) {
    this.timeStep = Math.max(0.001, Math.min(2, this.timeStep * factor));
    this.render();
    this.announce(`time step ${this.timeStep.toFixed(3)} seconds`);
  }

  setZoomLevel(n) {
    this.zoomLevel = n;
    this._recomputeTimeStep();
    this.render();
    this.announce(`zoom: ${ZOOM_LABEL[n]} (${this.timeStep.toFixed(3)} seconds)`);
  }

  _recomputeTimeStep() {
    if (this.timeMode !== "bars") return;
    const bpm = parseFloat(this.dom.fTempo.value) || 120;
    const beatSeconds = (4.0 / this.timeSig.den) * (60.0 / bpm);
    const fractions = {
      1: this.timeSig.num,
      2: this.timeSig.num / 2,
      3: 1,
      4: 0.5,
      5: 1 / 3,
      6: 0.25,
      7: 1 / 6,
      8: 0.125,
      9: 1 / 16,
    };
    this.timeStep = Math.max(0.001, (fractions[this.zoomLevel] ?? 1) * beatSeconds);
  }

  formatCursor() {
    if (this.timeMode === "bars") {
      const bpm = parseFloat(this.dom.fTempo.value) || 120;
      const beatSeconds = (4.0 / this.timeSig.den) * (60.0 / bpm);
      const totalBeats = this.cursorTime / beatSeconds;
      const bar = Math.floor(totalBeats / this.timeSig.num) + 1;
      const beat = (totalBeats % this.timeSig.num) + 1;
      return `bar ${bar} beat ${beat.toFixed(2)} (${this.cursorTime.toFixed(3)}s)`;
    }
    return `cursor ${this.cursorTime.toFixed(3)} seconds`;
  }

  // ---- describe for screen reader ---------------------------------------

  describeItem(item) {
    const label = item.label ? `${item.label}, ` : "";
    const track = this.tracks.length > 1 ? `[${this.trackName(item.trackId)}] ` : "";
    if (item.kind === "curveRegion") {
      return `${track}${label}curve region ${item.time.toFixed(3)}s to ${item.endTime.toFixed(3)}s, ${item.sharpnessPoints.length} sharpness points, ${item.intensityPoints.length} intensity points`;
    }
    if (item.kind === "curve") {
      return `${track}${label}curve at ${item.time.toFixed(3)}s, ${item.points.length} points, parameter ${item.parameterId}`;
    }
    const kind = item.kind === "transient" ? "transient" : "continuous";
    const dur = item.kind === "continuous" ? `, duration ${item.duration.toFixed(3)}s` : "";
    return `${track}${label}${kind} at ${item.time.toFixed(3)}s${dur}, intensity ${item.intensity.toFixed(2)}, sharpness ${item.sharpness.toFixed(2)}`;
  }

  // ---- insertion ---------------------------------------------------------

  insert(item) {
    if (!item.trackId) item.trackId = this.activeTrackId;
    this.items.push(item);
    this.selectedId = item.id;
    this.render();
    return item;
  }

  noteDurationSeconds() {
    if (this.timeMode === "bars") return this.timeStep;
    const bpm = parseFloat(this.dom.fTempo.value) || 120;
    return (4.0 / this.durationDenom) * (60.0 / bpm);
  }

  consumeAccent() {
    const a = this.pendingAccent;
    this.pendingAccent = false;
    return a;
  }

  insertMelodyNote(letter, accidental) {
    const dur = this.noteDurationSeconds();
    let freq = noteFreq(letter, accidental, this.octave);
    const clamped = freq < FREQ_MIN || freq > FREQ_MAX;
    const sharpness = freqToSharpness(freq);
    const accented = this.consumeAccent();
    let intensity = Math.min(1, 0.6 + (accented ? 0.15 : 0));
    const accStr = accidental === 1 ? "#" : accidental === -1 ? "b" : "";
    const label = `note ${letter}${accStr}${this.octave}${accented ? " (accented)" : ""}`;
    const item = makeContinuous({ time: this.cursorTime, duration: dur, intensity, sharpness, label });
    this.insert(item);
    this.cursorTime += dur;
    this.render();
    this.announce(`${label}${clamped ? ", clamped to haptic range" : ""}`);
  }

  insertDrum(letterKey) {
    const d = DRUM_LABELS[letterKey];
    if (!d) return;
    const dur = this.noteDurationSeconds();
    const accented = this.consumeAccent();
    let intensity = Math.min(1, 0.7 + (accented ? 0.15 : 0));
    const label = `${d.name}${accented ? " (accented)" : ""}`;
    let item;
    if (d.shape === "punch") {
      item = makeContinuous({
        time: this.cursorTime,
        duration: dur,
        intensity,
        sharpness: d.sharpness,
        attack: 0.0,
        decay: dur * 0.6,
        release: dur * 0.4,
        label,
      });
    } else if (d.shape === "hit") {
      item = makeTransient({ time: this.cursorTime, intensity, sharpness: d.sharpness, label });
    } else {
      item = makeContinuous({ time: this.cursorTime, duration: dur, intensity, sharpness: d.sharpness, label });
    }
    this.insert(item);
    this.cursorTime += dur;
    this.render();
    this.announce(label);
  }

  insertRawTransient() {
    const item = makeTransient({ time: this.cursorTime, intensity: 0.8, sharpness: 0.5, label: "transient" });
    this.insert(item);
    this.render();
    this.announce("transient inserted");
  }

  startOrCloseContinuous() {
    if (this.openContinuousId) {
      const item = this.items.find((it) => it.id === this.openContinuousId);
      this.openContinuousId = null;
      if (!item) return;
      let end = this.cursorTime;
      if (end < item.time) {
        const tmp = item.time;
        item.time = end;
        end = tmp;
      }
      item.duration = Math.max(0.01, end - item.time);
      this.render();
      this.announce(`continuous set, ${item.time.toFixed(3)}s to ${(item.time + item.duration).toFixed(3)}s, duration ${item.duration.toFixed(3)} seconds`);
    } else {
      const item = makeContinuous({ time: this.cursorTime, duration: 0.05, intensity: 0.8, sharpness: 0.5, label: "continuous" });
      this.insert(item);
      this.openContinuousId = item.id;
      this.announce(`continuous started at ${this.cursorTime.toFixed(3)} seconds, move cursor and press C again to set the end`);
    }
  }

  startOrCloseCurveRegion() {
    if (this.openCurveRegionId) {
      const region = this.items.find((it) => it.id === this.openCurveRegionId);
      this.openCurveRegionId = null;
      if (!region) return;
      let end = this.cursorTime;
      if (end < region.time) {
        const tmp = region.time;
        region.time = end;
        end = tmp;
      }
      region.endTime = Math.max(end, region.time + 0.01);
      this.render();
      this.announce(`curve region set, ${region.time.toFixed(3)}s to ${region.endTime.toFixed(3)}s`);
    } else {
      const region = makeCurveRegion({ time: this.cursorTime, endTime: this.cursorTime + 0.01, label: "curve region" });
      this.insert(region);
      this.openCurveRegionId = region.id;
      this.announce(`curve region started at ${this.cursorTime.toFixed(3)} seconds, move cursor and press Shift+C again to set the end`);
    }
  }

  findCurveRegionAtCursor() {
    return this.items.find((it) => it.kind === "curveRegion" && this.cursorTime >= it.time - 1e-9 && this.cursorTime <= it.endTime + 1e-9);
  }

  addCurvePointAtCursor() {
    const region = this.findCurveRegionAtCursor();
    if (!region) {
      this.alert("cursor is not inside a curve region, move it inside one first");
      return;
    }
    this.showPopup({
      title: "Add curve point",
      fields: [
        {
          id: "param",
          label: "Parameter",
          type: "radio",
          options: [
            ["sharpness", "Sharpness"],
            ["intensity", "Intensity"],
          ],
          value: "sharpness",
        },
        { id: "value", label: "Value (0-1)", type: "number", value: "0.5", step: "0.01", min: "0", max: "1" },
      ],
      onSubmit: (values) => {
        const relTime = this.cursorTime - region.time;
        const list = values.param === "intensity" ? region.intensityPoints : region.sharpnessPoints;
        const val = Math.min(1, Math.max(0, parseFloat(values.value) || 0));
        const idx = list.findIndex((p) => Math.abs(p.time - relTime) < 1e-6);
        if (idx >= 0) list[idx].value = val;
        else list.push({ time: relTime, value: val });
        list.sort((a, b) => a.time - b.time);
        this.render();
        this.announce(`${values.param} point set to ${val.toFixed(2)} at ${this.cursorTime.toFixed(3)} seconds`);
      },
    });
  }

  openEnvelopePopup(field) {
    const item = this.selectedItem();
    if (!item || item.kind === "curve" || item.kind === "curveRegion") {
      this.alert("select a transient or continuous event first");
      return;
    }
    const names = { attack: "Attack", decay: "Decay", release: "Release" };
    this.showPopup({
      title: `${names[field]} time`,
      fields: [{ id: "value", label: `${names[field]} (seconds, blank = default)`, type: "number", value: item[field] ?? "", step: "0.001", min: "0" }],
      onSubmit: (values) => {
        item[field] = values.value === "" ? null : Math.max(0, parseFloat(values.value) || 0);
        this.render();
        this.announce(`${names[field]} set to ${item[field] === null ? "default" : item[field].toFixed(3) + " seconds"}`);
      },
    });
  }

  openTimeSignaturePopup() {
    this.showPopup({
      title: "Time signature and tempo",
      fields: [
        { id: "num", label: "Beats per bar", type: "number", value: this.timeSig.num, step: "1", min: "1", max: "32" },
        { id: "den", label: "Beat unit (4 = quarter, 8 = eighth)", type: "number", value: this.timeSig.den, step: "1", min: "1", max: "32" },
        { id: "bpm", label: "Tempo (BPM)", type: "number", value: this.dom.fTempo.value, step: "1", min: "20", max: "400" },
      ],
      onSubmit: (values) => {
        this.timeSig = { num: Math.max(1, Math.round(+values.num) || 4), den: Math.max(1, Math.round(+values.den) || 4) };
        this.dom.fTempo.value = Math.max(20, Math.round(+values.bpm) || 120);
        this.timeMode = "bars";
        this.zoomLevel = 3;
        this._recomputeTimeStep();
        this.render();
        this.announce(
          `time signature ${this.timeSig.num}/${this.timeSig.den}, tempo ${this.dom.fTempo.value} bpm, arrow keys now move by bars and beats`
        );
      },
    });
  }

  insertRawContinuous() {
    // legacy single-press insert, kept for the detail-form / programmatic path
    const item = makeContinuous({ time: this.cursorTime, duration: 0.2, intensity: 0.8, sharpness: 0.5, label: "continuous" });
    this.insert(item);
    this.cursorTime += 0.2;
    this.render();
    this.announce("continuous event inserted, 0.2 seconds");
  }

  // ---- edit / delete / clipboard -----------------------------------------

  deleteSelected() {
    const item = this.selectedItem();
    if (!item) {
      this.announce("nothing selected");
      return;
    }
    const idx = this.selectedIndex();
    this.items = this.items.filter((it) => it.id !== item.id);
    const list = this.visibleItems();
    this.selectedId = list.length ? list[Math.min(idx, list.length - 1)].id : null;
    this.render();
    this.announce(`deleted ${item.label || item.kind}`);
  }

  markRange() {
    if (this.rangeStart === null) {
      this.rangeStart = this.cursorTime;
      this.rangeEnd = null;
      this.render();
      this.announce(`range start marked at ${this.cursorTime.toFixed(3)} seconds`);
    } else if (this.rangeEnd === null) {
      let a = this.rangeStart;
      let b = this.cursorTime;
      if (b < a) [a, b] = [b, a];
      this.rangeStart = a;
      this.rangeEnd = b;
      this.render();
      this.announce(`range end marked, ${this.itemsInRange().length} items on active track between ${a.toFixed(3)}s and ${b.toFixed(3)}s`);
    } else {
      this.rangeStart = this.cursorTime;
      this.rangeEnd = null;
      this.render();
      this.announce(`range restarted at ${this.cursorTime.toFixed(3)} seconds`);
    }
  }

  clearRange() {
    if (this.rangeStart === null) return;
    this.rangeStart = null;
    this.rangeEnd = null;
    this.render();
    this.announce("range cleared");
  }

  itemsInRange() {
    if (this.rangeStart === null || this.rangeEnd === null) return [];
    return this.items.filter((it) => it.trackId === this.activeTrackId && it.time >= this.rangeStart - 1e-9 && it.time <= this.rangeEnd + 1e-9);
  }

  copySelectionOrRange() {
    if (this.rangeStart !== null && this.rangeEnd !== null) {
      const items = this.itemsInRange();
      if (!items.length) {
        this.announce("no items in the marked range on the active track");
        return;
      }
      this.clipboard = { multi: true, anchor: this.rangeStart, items: items.map((it) => JSON.parse(JSON.stringify(it))) };
      this.announce(`copied ${items.length} items from the marked range`);
      return;
    }
    const item = this.selectedItem();
    if (!item) {
      this.announce("nothing selected to copy");
      return;
    }
    this.clipboard = { multi: false, item: JSON.parse(JSON.stringify(item)) };
    this.announce(`copied ${item.label || item.kind}`);
  }

  pasteAtCursor() {
    if (!this.clipboard) {
      this.announce("clipboard empty");
      return;
    }
    if (this.clipboard.multi) {
      const shift = this.cursorTime - this.clipboard.anchor;
      const pasted = this.clipboard.items.map((src) => {
        const copy = cloneItem(src);
        copy.time = src.time + shift;
        if (copy.kind === "curveRegion") copy.endTime = src.endTime + shift;
        copy.trackId = this.activeTrackId;
        return copy;
      });
      this.items.push(...pasted);
      this.selectedId = pasted[0] ? pasted[0].id : this.selectedId;
      this.render();
      this.announce(`pasted ${pasted.length} items at ${this.cursorTime.toFixed(3)} seconds`);
      return;
    }
    const copy = cloneItem(this.clipboard.item);
    const shift = this.cursorTime - copy.time;
    copy.time = this.cursorTime;
    if (copy.kind === "curveRegion") copy.endTime += shift;
    copy.trackId = this.activeTrackId;
    this.insert(copy);
    this.announce(`pasted ${copy.label || copy.kind} at ${this.cursorTime.toFixed(3)} seconds`);
  }

  nudgeSelected(field, delta) {
    const item = this.selectedItem();
    if (!item || item.kind === "curve" || item.kind === "curveRegion") {
      this.announce("no editable item selected");
      return;
    }
    item[field] = Math.min(1, Math.max(0, +(item[field] + delta).toFixed(3)));
    this.render();
    this.announce(`${field} ${item[field].toFixed(2)}`);
  }

  // ---- playback -----------------------------------------------------------

  previewSelected() {
    const item = this.selectedItem();
    if (!item) {
      this.announce("nothing selected");
      return;
    }
    this.audio.previewItem(item, this.items);
  }

  playFromCursor() {
    this.audio.playFrom(this.items, this.cursorTime, (item) => {
      this.select(item.id, { moveCursor: false, quiet: true });
    });
    this.announce(`playing from ${this.cursorTime.toFixed(3)} seconds`);
  }

  stopPlayback() {
    this.audio.stopAll();
    this.announce("stopped");
  }

  // ---- tracks -----------------------------------------------------------

  addTrack(name) {
    const id = "track" + (this.tracks.length + 1) + "_" + Date.now().toString(36);
    this.tracks.push({ id, name });
    this.activeTrackId = id;
    this.renderTracks();
    this.announce(`added track ${name}, now active`);
  }

  deleteActiveTrack() {
    if (this.tracks.length <= 1) {
      this.alert("can't delete the only track");
      return;
    }
    const inUse = this.items.some((it) => it.trackId === this.activeTrackId);
    if (inUse) {
      this.alert("this track still has items on it, delete or move them first");
      return;
    }
    const name = this.trackName(this.activeTrackId);
    this.tracks = this.tracks.filter((t) => t.id !== this.activeTrackId);
    this.activeTrackId = this.tracks[0].id;
    this.renderTracks();
    this.render();
    this.announce(`deleted track ${name}`);
  }

  // ---- rendering ------------------------------------------------------

  render() {
    const list = this.visibleItems();
    const container = this.dom.itemList;
    container.innerHTML = "";
    list.forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = "item-row";
      row.id = "item-" + item.id;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(item.id === this.selectedId));
      const kindLabel = item.kind === "transient" ? "Transient" : item.kind === "continuous" ? "Continuous" : item.kind === "curveRegion" ? "Curve region" : "Curve";
      const inRange =
        this.rangeStart !== null && this.rangeEnd !== null && item.trackId === this.activeTrackId && item.time >= this.rangeStart - 1e-9 && item.time <= this.rangeEnd + 1e-9;
      if (inRange) row.classList.add("in-range");
      const trackTag = this.tracks.length > 1 ? `[${this.trackName(item.trackId)}] ` : "";
      let ivs = "";
      if (item.kind === "transient" || item.kind === "continuous") ivs = `I ${item.intensity.toFixed(2)}`;
      let svs = "";
      if (item.kind === "transient" || item.kind === "continuous") svs = `S ${item.sharpness.toFixed(2)}`;
      row.innerHTML = `
        <span class="col-index">${idx + 1}</span>
        <span class="col-time">${item.time.toFixed(3)}s${item.kind === "curveRegion" ? "-" + item.endTime.toFixed(3) + "s" : ""}</span>
        <span class="col-kind">${kindLabel}</span>
        <span class="col-intensity">${ivs}</span>
        <span class="col-sharpness">${svs}</span>
        <span class="col-label">${trackTag}${item.label || ""}</span>
      `;
      row.addEventListener("click", () => {
        this.dom.itemList.focus();
        this.select(item.id);
      });
      container.appendChild(row);
    });

    this.dom.emptyHint.hidden = list.length > 0;
    this.dom.itemList.setAttribute("aria-activedescendant", this.selectedId ? "item-" + this.selectedId : "");

    this.dom.statusTime.textContent = this.formatCursor();
    const sel = this.selectedItem();
    const idx = this.selectedIndex();
    this.dom.statusSelection.textContent = sel ? `Selected: item ${idx + 1} of ${list.length}` : "Selected: none";
    this.dom.statusCount.textContent = `${list.length} item${list.length === 1 ? "" : "s"}${this.soloTrack ? " (solo)" : ""}`;
    this.dom.statusOctave.textContent = `Octave: ${this.octave}`;
    this.dom.statusDuration.textContent =
      this.timeMode === "bars" ? `Zoom: ${ZOOM_LABEL[this.zoomLevel]}` : `Duration: ${DENOM_NAME[this.durationDenom]}`;
    this.dom.statusStep.textContent = `Time step: ${this.timeStep.toFixed(3)}s`;
  }

  renderTracks() {
    const container = this.dom.trackList;
    container.innerHTML = "";
    this.tracks.forEach((t) => {
      const row = document.createElement("div");
      row.className = "track-row";
      row.id = "track-" + t.id;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(t.id === this.activeTrackId));
      row.textContent = t.name + (t.id === this.activeTrackId ? " (active)" : "");
      row.addEventListener("click", () => {
        this.activeTrackId = t.id;
        this.dom.trackList.focus();
        this.renderTracks();
        this.render();
        this.announce(`active track: ${t.name}`);
      });
      container.appendChild(row);
    });
    container.setAttribute("aria-activedescendant", "track-" + this.activeTrackId);
  }

  // ---- toolbar bindings -----------------------------------------------

  _bindToolbar() {
    for (const radio of this.dom.modeRadios) {
      radio.addEventListener("change", () => {
        if (radio.checked) {
          this.mode = radio.value;
          this.announce(`mode: ${radio.value}`);
        }
      });
    }
    this.dom.btnPlayFromCursor.addEventListener("click", () => this.playFromCursor());
    this.dom.btnPlaySelected.addEventListener("click", () => this.previewSelected());
    this.dom.btnStop.addEventListener("click", () => this.stopPlayback());
    this.dom.btnHelp.addEventListener("click", () => {
      const expanded = this.dom.btnHelp.getAttribute("aria-expanded") === "true";
      this.dom.btnHelp.setAttribute("aria-expanded", String(!expanded));
      this.dom.helpPanel.hidden = expanded;
    });
  }

  _setModeRadio(value) {
    for (const r of this.dom.modeRadios) r.checked = r.value === value;
    this.mode = value;
  }

  // ---- tracks panel bindings ---------------------------------------------

  _bindTracks() {
    this.dom.btnAddTrack.addEventListener("click", () => {
      this.showPopup({
        title: "New track",
        fields: [{ id: "name", label: "Track name", type: "text", value: `Track ${this.tracks.length + 1}` }],
        onSubmit: (values) => this.addTrack(values.name || `Track ${this.tracks.length + 1}`),
      });
    });
    this.dom.btnDeleteTrack.addEventListener("click", () => this.deleteActiveTrack());
    this.dom.chkSoloTrack.addEventListener("change", () => {
      this.soloTrack = this.dom.chkSoloTrack.checked;
      this.render();
      this.announce(this.soloTrack ? "showing only the active track" : "showing all tracks");
    });
    this.dom.trackList.addEventListener("keydown", (e) => {
      const idx = this.tracks.findIndex((t) => t.id === this.activeTrackId);
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = this.tracks[Math.max(0, idx - 1)];
        this.activeTrackId = next.id;
        this.renderTracks();
        this.render();
        this.announce(`active track: ${next.name}`);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = this.tracks[Math.min(this.tracks.length - 1, idx + 1)];
        this.activeTrackId = next.id;
        this.renderTracks();
        this.render();
        this.announce(`active track: ${next.name}`);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const track = this.tracks[idx];
        this.showPopup({
          title: "Rename track",
          fields: [{ id: "name", label: "Track name", type: "text", value: track.name }],
          onSubmit: (values) => {
            track.name = values.name || track.name;
            this.renderTracks();
            this.render();
            this.announce(`track renamed to ${track.name}`);
          },
        });
      }
    });
    this.renderTracks();
  }

  // ---- popup dialog (used for precise value entry) ----------------------

  _bindPopup() {
    this.dom.popupForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this._submitPopup();
    });
    this.dom.popupCancel.addEventListener("click", () => this.closePopup(true));
    this.dom.popup.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closePopup(true);
      }
    });
  }

  showPopup({ title, fields, onSubmit, infoOnly = false }) {
    this._popupFields = fields;
    this._popupSubmit = onSubmit;
    this.dom.popupTitle.textContent = title;
    this.dom.popupFields.innerHTML = "";
    let firstInput = null;
    for (const f of fields) {
      const row = document.createElement("div");
      row.className = "field-row";
      if (f.type === "radio") {
        const legend = document.createElement("span");
        legend.textContent = f.label;
        row.appendChild(legend);
        const group = document.createElement("span");
        group.className = "popup-radio-group";
        for (const [val, optLabel] of f.options) {
          const id = `popup_${f.id}_${val}`;
          const label = document.createElement("label");
          const input = document.createElement("input");
          input.type = "radio";
          input.name = `popup_${f.id}`;
          input.id = id;
          input.value = val;
          input.checked = val === f.value;
          label.appendChild(input);
          label.append(" " + optLabel);
          group.appendChild(label);
          if (!firstInput) firstInput = input;
        }
        row.appendChild(group);
      } else {
        const label = document.createElement("label");
        label.setAttribute("for", "popup_" + f.id);
        label.textContent = f.label;
        const input = document.createElement("input");
        input.type = f.type === "number" ? "number" : "text";
        input.id = "popup_" + f.id;
        if (f.step !== undefined) input.step = f.step;
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        input.value = f.value === undefined || f.value === null ? "" : f.value;
        row.appendChild(label);
        row.appendChild(input);
        if (!firstInput) firstInput = input;
      }
      this.dom.popupFields.appendChild(row);
    }
    this.dom.popupOk.hidden = !!infoOnly;
    this.dom.popup.hidden = false;
    this._popupReturnFocus = document.activeElement;
    (firstInput || this.dom.popupCancel).focus();
  }

  _submitPopup() {
    const values = {};
    for (const f of this._popupFields) {
      if (f.type === "radio") {
        const checked = this.dom.popupFields.querySelector(`input[name="popup_${f.id}"]:checked`);
        values[f.id] = checked ? checked.value : f.value;
      } else {
        values[f.id] = document.getElementById("popup_" + f.id).value;
      }
    }
    const submit = this._popupSubmit;
    this.closePopup(false);
    if (submit) submit(values);
  }

  closePopup(announceCancel) {
    this.dom.popup.hidden = true;
    if (this._popupReturnFocus && this._popupReturnFocus.focus) this._popupReturnFocus.focus();
    else this.dom.itemList.focus();
    if (announceCancel) this.announce("cancelled");
  }

  // ---- compact shortcuts popup (H key) -----------------------------------

  showShortcutsPopup() {
    this.dom.popupTitle.textContent = "Keyboard shortcuts";
    this.dom.popupFields.innerHTML = "";
    const list = document.createElement("dl");
    list.className = "shortcut-list";
    for (const [keys, desc] of SHORTCUT_SUMMARY) {
      const dt = document.createElement("dt");
      dt.textContent = keys;
      const dd = document.createElement("dd");
      dd.textContent = desc;
      list.appendChild(dt);
      list.appendChild(dd);
    }
    this.dom.popupFields.appendChild(list);
    this._popupFields = [];
    this._popupSubmit = null;
    this.dom.popupOk.hidden = true;
    this.dom.popup.hidden = false;
    this._popupReturnFocus = document.activeElement;
    this.dom.popupCancel.textContent = "Close";
    this.dom.popupCancel.focus();
  }

  // ---- form bindings (detail edit) -------------------------------------

  _bindForm() {
    this.dom.editForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this._applyForm();
    });
    this.dom.btnCancelEdit.addEventListener("click", () => this._closeForm());
  }

  openForm() {
    const item = this.selectedItem();
    if (!item) {
      this.announce("nothing selected to edit");
      return;
    }
    this.dom.detailForm.hidden = false;
    this.dom.editKind.textContent = `Editing ${item.kind}`;
    this.dom.fTime.value = item.time;
    this.dom.rowDuration.style.display = item.kind === "continuous" ? "" : "none";
    if (item.kind === "continuous") this.dom.fDuration.value = item.duration;
    this.dom.fIntensity.value = item.kind === "transient" || item.kind === "continuous" ? item.intensity : "";
    this.dom.fSharpness.value = item.kind === "transient" || item.kind === "continuous" ? item.sharpness : "";
    this.dom.fAttack.value = item.attack ?? "";
    this.dom.fDecay.value = item.decay ?? "";
    this.dom.fRelease.value = item.release ?? "";
    this.dom.fLabel.value = item.label || "";
    const editable = item.kind === "transient" || item.kind === "continuous";
    this.dom.fIntensity.disabled = !editable;
    this.dom.fSharpness.disabled = !editable;
    this.dom.fAttack.disabled = item.kind !== "continuous";
    this.dom.fDecay.disabled = item.kind !== "continuous";
    this.dom.fRelease.disabled = item.kind !== "continuous";
    this.dom.fTime.focus();
    this.announce(`editing ${item.kind}, form opened`);
  }

  _closeForm() {
    this.dom.detailForm.hidden = true;
    this.dom.itemList.focus();
    this.announce("edit cancelled");
  }

  _applyForm() {
    const item = this.selectedItem();
    if (!item) return;
    item.time = parseFloat(this.dom.fTime.value) || 0;
    if (item.kind === "continuous") item.duration = Math.max(0.001, parseFloat(this.dom.fDuration.value) || 0.1);
    if (item.kind === "transient" || item.kind === "continuous") {
      item.intensity = Math.min(1, Math.max(0, parseFloat(this.dom.fIntensity.value) || 0));
      item.sharpness = Math.min(1, Math.max(0, parseFloat(this.dom.fSharpness.value) || 0));
      item.attack = this.dom.fAttack.value === "" ? null : parseFloat(this.dom.fAttack.value);
      item.decay = this.dom.fDecay.value === "" ? null : parseFloat(this.dom.fDecay.value);
      item.release = this.dom.fRelease.value === "" ? null : parseFloat(this.dom.fRelease.value);
    }
    item.label = this.dom.fLabel.value;
    this.dom.detailForm.hidden = true;
    this.dom.itemList.focus();
    this.render();
    this.announce(`applied changes to ${item.label || item.kind}`);
  }

  // ---- keyboard handling on the list ------------------------------------

  _bindListKeys() {
    const el = this.dom.itemList;
    el.addEventListener("keydown", (e) => this._onKeydown(e));
  }

  _onKeydown(e) {
    const k = e.key;

    // Navigation ------------------------------------------------------
    if (k === "ArrowLeft" && !e.ctrlKey) {
      e.preventDefault();
      this.moveCursorBy(-1);
      return;
    }
    if (k === "ArrowRight" && !e.ctrlKey) {
      e.preventDefault();
      this.moveCursorBy(1);
      return;
    }
    if (k === "ArrowLeft" && e.ctrlKey) {
      e.preventDefault();
      this.moveSelectionAdjacent(-1);
      return;
    }
    if (k === "ArrowRight" && e.ctrlKey) {
      e.preventDefault();
      this.moveSelectionAdjacent(1);
      return;
    }
    if (k === "[") {
      e.preventDefault();
      this.changeStep(0.5);
      return;
    }
    if (k === "]") {
      e.preventDefault();
      this.changeStep(2);
      return;
    }
    if (k === "Home") {
      e.preventDefault();
      this.cursorTime = 0;
      this.render();
      this.announce("cursor at start, 0 seconds");
      return;
    }
    if (k === "End") {
      e.preventDefault();
      this.cursorTime = this.patternEnd();
      this.render();
      this.announce(`cursor at end, ${this.cursorTime.toFixed(3)} seconds`);
      return;
    }
    if (k === "ArrowUp" && e.ctrlKey) {
      e.preventDefault();
      this.octave += 1;
      this.render();
      this.announce(`octave ${this.octave}`);
      return;
    }
    if (k === "ArrowDown" && e.ctrlKey) {
      e.preventDefault();
      this.octave -= 1;
      this.render();
      this.announce(`octave ${this.octave}`);
      return;
    }
    if (k === "ArrowUp" && e.shiftKey) {
      e.preventDefault();
      this.nudgeSelected("sharpness", 0.05);
      return;
    }
    if (k === "ArrowDown" && e.shiftKey) {
      e.preventDefault();
      this.nudgeSelected("sharpness", -0.05);
      return;
    }
    if (k === "ArrowUp") {
      e.preventDefault();
      this.nudgeSelected("intensity", 0.05);
      return;
    }
    if (k === "ArrowDown") {
      e.preventDefault();
      this.nudgeSelected("intensity", -0.05);
      return;
    }

    // Help / mode switch -----------------------------------------------
    if (k.toLowerCase() === "h" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.showShortcutsPopup();
      return;
    }
    if (k.toLowerCase() === "n" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this._setModeRadio("normal");
      this.render();
      this.announce("mode: normal (T transient, C continuous, Shift+C curve region)");
      return;
    }

    // Range mark ---------------------------------------------------------
    if (k.toLowerCase() === "m" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.markRange();
      return;
    }
    if (k.toLowerCase() === "v" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.soloTrack = !this.soloTrack;
      this.dom.chkSoloTrack.checked = this.soloTrack;
      this.render();
      this.announce(this.soloTrack ? "showing only the active track" : "showing all tracks");
      return;
    }

    // Time signature / tempo ---------------------------------------------
    if (k === "-") {
      e.preventDefault();
      this.openTimeSignaturePopup();
      return;
    }

    // Editing -----------------------------------------------------------
    if (k === "Enter") {
      e.preventDefault();
      this.openForm();
      return;
    }
    if (k === "Delete" || k === "Backspace") {
      e.preventDefault();
      this.deleteSelected();
      return;
    }
    if (e.ctrlKey && k.toLowerCase() === "c") {
      e.preventDefault();
      this.copySelectionOrRange();
      return;
    }
    if (e.ctrlKey && k.toLowerCase() === "v") {
      e.preventDefault();
      this.pasteAtCursor();
      return;
    }

    // Playback ------------------------------------------------------------
    if (e.ctrlKey && k === " ") {
      e.preventDefault();
      this.playFromCursor();
      return;
    }
    if (k === "Escape") {
      e.preventDefault();
      if (this.rangeStart !== null) this.clearRange();
      else this.stopPlayback();
      return;
    }
    if (k.toLowerCase() === "p" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.previewSelected();
      return;
    }
    if (k.toLowerCase() === "p" && e.shiftKey) {
      e.preventDefault();
      this.addCurvePointAtCursor();
      return;
    }

    // Digits: zoom (bar/beat mode) or note duration (raw mode) -----------
    if (/^[1-9]$/.test(k) && !e.ctrlKey && !e.altKey) {
      if (this.timeMode === "bars") {
        e.preventDefault();
        this.setZoomLevel(parseInt(k, 10));
        return;
      }
      if (k in KEY_TO_DENOM) {
        e.preventDefault();
        this.durationDenom = KEY_TO_DENOM[k];
        this.render();
        this.announce(`duration ${DENOM_NAME[this.durationDenom]}`);
        return;
      }
    }

    // Accent ------------------------------------------------------------
    if (k === "!") {
      e.preventDefault();
      this.pendingAccent = true;
      this.announce("accent armed for next note");
      return;
    }

    // Normal mode: transient / continuous / curve region / envelope -------
    if (this.mode === "normal") {
      if (k.toLowerCase() === "t" && !e.ctrlKey) {
        e.preventDefault();
        this.insertRawTransient();
        return;
      }
      if (k.toLowerCase() === "c" && e.shiftKey) {
        e.preventDefault();
        this.startOrCloseCurveRegion();
        return;
      }
      if (k.toLowerCase() === "c" && !e.ctrlKey) {
        e.preventDefault();
        this.startOrCloseContinuous();
        return;
      }
      if (k.toLowerCase() === "a" && !e.ctrlKey) {
        e.preventDefault();
        this.openEnvelopePopup("attack");
        return;
      }
      if (k.toLowerCase() === "d" && !e.ctrlKey) {
        e.preventDefault();
        this.openEnvelopePopup("decay");
        return;
      }
      if (k.toLowerCase() === "r" && !e.ctrlKey) {
        e.preventDefault();
        this.openEnvelopePopup("release");
        return;
      }
    }

    // Mode-specific letter insertion ---------------------------------------
    if (this.mode === "melody" && /^[a-gA-G]$/.test(k)) {
      e.preventDefault();
      const letter = k.toUpperCase();
      const accidental = e.shiftKey ? 1 : e.altKey ? -1 : 0;
      this.insertMelodyNote(letter, accidental);
      return;
    }
    if (this.mode === "drums" && /^[ktshxocrKTSHXOCR]$/.test(k)) {
      e.preventDefault();
      this.insertDrum(k.toLowerCase());
      return;
    }
  }
}
