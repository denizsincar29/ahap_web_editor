import {
  makeTransient,
  makeContinuous,
  makeCurveRegion,
  cloneItem,
  sortItems,
  itemEndTime,
  freqToSharpness,
  sharpnessToFreq,
  FREQ_MIN,
  FREQ_MAX,
} from "./ahap.js";
import { AudioEngine } from "./audio.js";

// Semitone offsets from C, used for MuseScore-style nearest-octave note
// entry (see Editor._resolveNoteMidiAndFreq).
const NOTE_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

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
// MuseScore-style duration digit keys: 1 = 64th ... 7 = whole, 8 = double
// whole (breve), 9 = longa (4 whole notes), 0 = rest of current duration.
// The "denom" here means "quarters per whole note is 4/denom", same
// convention as a time signature's beat unit, so denom < 1 is valid.
const KEY_TO_DENOM = { 1: 64, 2: 32, 3: 16, 4: 8, 5: 4, 6: 2, 7: 1, 8: 0.5, 9: 0.25 };
const DENOM_NAME = {
  64: "sixty-fourth",
  32: "thirty-second",
  16: "sixteenth",
  8: "eighth",
  4: "quarter",
  2: "half",
  1: "whole",
  0.5: "double whole (breve)",
  0.25: "longa",
};
// Zoom levels 1-9 (Shift+1..Shift+9) while in bar/beat time mode, expressed
// as a fraction of one beat (levels 1-2 are fractions of a whole bar).
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
  ["Left / Right", "move cursor by one step; clears any selection"],
  ["Shift+Left / Shift+Right", "extend/shrink a time-range selection"],
  ["Ctrl+Left / Ctrl+Right", "move cursor by one bar"],
  ["Ctrl+Shift+Left / Right", "extend selection by one bar"],
  ["Up / Down", "switch the active track"],
  ["Shift+Up / Shift+Down", "shrink / grow the selection across tracks"],
  ["Ctrl+Up / Ctrl+Down", "octave-shift the last note typed (Melody mode); next notes continue from there"],
  ["PageUp / PageDown", "nudge selected item's intensity"],
  ["Shift+PageUp / PageDown", "nudge selected item's sharpness"],
  ["[ / ]", "halve / double the time step (seconds mode)"],
  ["Home / End", "cursor to start / end of pattern"],
  ["N", "switch to Normal insert mode (like MuseScore's N)"],
  ["T (Normal mode)", "insert a transient at the cursor"],
  ["C ... C (Normal mode)", "start / close a continuous event"],
  ["Shift+C ... Shift+C (Melody mode)", "capture notes into a pitch-bend curve + carrier event"],
  ["Shift+C ... Shift+C (other modes)", "start / close an empty curve region for manual points"],
  ["Shift+P", "add a curve point to a closed region (popup: parameter + value)"],
  ["A / D / R (Normal mode)", "set attack / decay / release (popup)"],
  ["- (dash)", "set time signature + tempo, switch to bar/beat cursor"],
  ["1-9", "note/rest duration, MuseScore-style (1=64th ... 7=whole, 8=breve, 9=longa)"],
  ["0", "insert a rest of the current duration"],
  ["Shift+1 - Shift+9", "zoom the cursor step while in bar/beat mode"],
  ["A-G (Melody mode)", "insert a note; Shift = sharp, Alt = flat (for C#, use Alt+D since Shift+C is taken by curve capture)"],
  ["k t s h x o c r (Drums mode)", "insert a drum hit"],
  ["Ctrl+C / Ctrl+X / Ctrl+V", "copy / cut selection (or item) / paste at cursor"],
  ["Enter", "open the full detail form for the selected item"],
  ["Delete / Backspace", "delete the selected item"],
  ["P", "preview the selected item"],
  ["Ctrl+Space", "play the whole pattern from the cursor"],
  ["Ctrl+Shift+Space", "play the whole pattern from the beginning"],
  ["Escape", "stop playback / clear selection / cancel a popup"],
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
    // Melody-mode curve capture: while active, note letters become pitch
    // points instead of independent events (see startOrCloseCurveRegion).
    this._curveCapture = null;

    // Nearest-octave note entry, like MuseScore: the octave of each new
    // note is chosen to be closest to the previously entered pitch, not a
    // fixed "current octave". `octave` is still kept in sync for display
    // and as the starting point before any note has been entered.
    this.lastNoteMidi = null;
    this._lastNoteItemId = null;

    // bar/beat time mode
    this.timeMode = "raw"; // 'raw' | 'bars'
    this.timeSig = { num: 4, den: 4 };
    this.zoomLevel = 3;

    // tracks (editor-only concept, merged together on .ahap export)
    this.tracks = [{ id: "track1", name: "Track 1" }];
    this.activeTrackId = "track1";
    this.soloTrack = false;

    // time-range selection for copy/cut, can span multiple tracks
    this.selection = null; // { anchor, start, end, trackIds: Set<string> }

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
    this.selection = null;
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
    this.selection = null;
    this.cursorTime = Math.max(0, this.cursorTime + deltaSteps * this.timeStep);
    this.render();
    this.announce(this.formatCursor());
  }

  moveCursorByBar(direction) {
    this.selection = null;
    this.cursorTime = Math.max(0, this.cursorTime + direction * this._barSeconds());
    this.render();
    this.announce(this.formatCursor());
  }

  _barSeconds() {
    const bpm = parseFloat(this.dom.fTempo.value) || 120;
    const beatSeconds = (4.0 / this.timeSig.den) * (60.0 / bpm);
    return beatSeconds * this.timeSig.num;
  }

  _ensureSelectionAnchor() {
    if (!this.selection) {
      this.selection = { anchor: this.cursorTime, start: this.cursorTime, end: this.cursorTime, trackIds: new Set([this.activeTrackId]) };
    }
  }

  _moveCursorWithinSelection(newCursorTime) {
    this._ensureSelectionAnchor();
    this.cursorTime = Math.max(0, newCursorTime);
    const a = this.selection.anchor;
    const b = this.cursorTime;
    this.selection.start = Math.min(a, b);
    this.selection.end = Math.max(a, b);
    this.render();
  }

  extendSelectionBySteps(direction) {
    this._moveCursorWithinSelection(this.cursorTime + direction * this.timeStep);
    this.announce(this._describeSelection());
  }

  extendSelectionByBar(direction) {
    this._moveCursorWithinSelection(this.cursorTime + direction * this._barSeconds());
    this.announce(this._describeSelection());
  }

  extendSelectionTrackDown() {
    this._ensureSelectionAnchor();
    const currentIdx = this.tracks.map((t, i) => (this.selection.trackIds.has(t.id) ? i : -1)).filter((i) => i >= 0);
    const maxIdx = Math.max(...currentIdx);
    if (maxIdx + 1 < this.tracks.length) this.selection.trackIds.add(this.tracks[maxIdx + 1].id);
    this.render();
    this.announce(this._describeSelection());
  }

  extendSelectionTrackUp() {
    if (!this.selection || this.selection.trackIds.size <= 1) {
      this.announce("selection has only one track");
      return;
    }
    const currentIdx = this.tracks.map((t, i) => (this.selection.trackIds.has(t.id) ? i : -1)).filter((i) => i >= 0);
    const maxIdx = Math.max(...currentIdx);
    this.selection.trackIds.delete(this.tracks[maxIdx].id);
    this.render();
    this.announce(this._describeSelection());
  }

  _describeSelection() {
    if (!this.selection) return "no selection";
    const n = this.itemsInSelection().length;
    const trackNames = [...this.selection.trackIds].map((id) => this.trackName(id)).join(", ");
    return `selection ${this.selection.start.toFixed(3)}s to ${this.selection.end.toFixed(3)}s on ${trackNames}, ${n} items`;
  }

  clearSelection() {
    if (!this.selection) return false;
    this.selection = null;
    this.render();
    this.announce("selection cleared");
    return true;
  }

  switchActiveTrack(direction) {
    const idx = this.tracks.findIndex((t) => t.id === this.activeTrackId);
    const next = this.tracks[Math.min(this.tracks.length - 1, Math.max(0, idx + direction))];
    this.activeTrackId = next.id;
    this.renderTracks();
    this.render();
    this.announce(`active track: ${next.name}`);
  }

  changeStep(factor) {
    this.timeStep = Math.max(0.001, Math.min(2, this.timeStep * factor));
    this.render();
    this.announce(`time step ${this.timeStep.toFixed(3)} seconds`);
  }

  setZoomLevel(n) {
    if (this.timeMode !== "bars") {
      this.announce("zoom only applies in bar/beat mode, press dash first to set a time signature");
      return;
    }
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

  insertRestCurrentDuration() {
    const dur = this.noteDurationSeconds();
    this.selection = null;
    this.cursorTime += dur;
    this.render();
    this.announce(`rest, ${DENOM_NAME[this.durationDenom] || this.durationDenom}, cursor now ${this.cursorTime.toFixed(3)} seconds`);
  }

  // Picks the octave for a newly typed note letter the way MuseScore does:
  // whichever candidate octave puts the note closest to the last entered
  // pitch (falls back to the manually-set `this.octave` for the very
  // first note of a session).
  _resolveNoteMidiAndFreq(letter, accidental) {
    const pitchClass = (((NOTE_SEMITONE[letter] + accidental) % 12) + 12) % 12;
    let midi;
    if (this.lastNoteMidi === null || this.lastNoteMidi === undefined) {
      midi = (this.octave + 1) * 12 + NOTE_SEMITONE[letter] + accidental;
    } else {
      const ref = this.lastNoteMidi;
      const base = ref - (((ref % 12) + 12) % 12);
      let best = base + pitchClass;
      for (const offset of [-12, 0, 12]) {
        const candidate = base + pitchClass + offset;
        if (Math.abs(candidate - ref) < Math.abs(best - ref)) best = candidate;
      }
      midi = best;
    }
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    return { midi, freq };
  }

  // Ctrl+Up/Ctrl+Down: transposes the most recently entered note (or the
  // in-progress curve-capture note) by an octave, and shifts the
  // reference pitch so subsequent notes continue from there - matching
  // MuseScore, where octave changes stick for what you type next.
  _shiftOctave(direction) {
    if (this._curveCapture && this._curveCapture.notes.length) {
      const last = this._curveCapture.notes[this._curveCapture.notes.length - 1];
      last.sharpness = freqToSharpness(sharpnessToFreq(last.sharpness) * Math.pow(2, direction));
      this.lastNoteMidi = (this.lastNoteMidi ?? 60) + direction * 12;
      this.announce(`curve note octave ${direction > 0 ? "up" : "down"}`);
      return;
    }
    if (this.lastNoteMidi !== null && this.lastNoteMidi !== undefined) {
      this.lastNoteMidi += direction * 12;
      this.octave = Math.floor(this.lastNoteMidi / 12) - 1;
      const item = this.selectedItem();
      if (item && this._lastNoteItemId === item.id && (item.kind === "transient" || item.kind === "continuous")) {
        item.sharpness = freqToSharpness(sharpnessToFreq(item.sharpness) * Math.pow(2, direction));
      }
      this.render();
      this.announce(`octave ${direction > 0 ? "up" : "down"}`);
    } else {
      this.octave += direction;
      this.render();
      this.announce(`octave ${this.octave}`);
    }
  }

  insertMelodyNote(letter, accidental) {
    const dur = this.noteDurationSeconds();
    const { midi, freq } = this._resolveNoteMidiAndFreq(letter, accidental);
    const clamped = freq < FREQ_MIN || freq > FREQ_MAX;
    const sharpness = freqToSharpness(freq);
    const accented = this.consumeAccent();
    let intensity = Math.min(1, 0.6 + (accented ? 0.15 : 0));
    const accStr = accidental === 1 ? "#" : accidental === -1 ? "b" : "";
    const noteOctave = Math.floor(midi / 12) - 1;
    const label = `note ${letter}${accStr}${noteOctave}${accented ? " (accented)" : ""}`;
    const item = makeContinuous({ time: this.cursorTime, duration: dur, intensity, sharpness, label });
    this.insert(item);
    this.lastNoteMidi = midi;
    this._lastNoteItemId = item.id;
    this.octave = noteOctave;
    this.cursorTime += dur;
    this.render();
    this.announce(`${label}${clamped ? ", clamped to haptic range" : ""}`);
  }

  // Called instead of insertMelodyNote while a curve capture is open
  // (Shift+C in Melody mode): the note becomes a pitch point rather than
  // its own event - see _closeCurveCapture for how it turns into a
  // smooth pitch-bend curve on a single underlying continuous event.
  insertCurveCaptureNote(letter, accidental) {
    const dur = this.noteDurationSeconds();
    const { midi, freq } = this._resolveNoteMidiAndFreq(letter, accidental);
    const clamped = freq < FREQ_MIN || freq > FREQ_MAX;
    const sharpness = freqToSharpness(freq);
    const accented = this.consumeAccent();
    this._curveCapture.notes.push({ sharpness, duration: dur, accented });
    this.lastNoteMidi = midi;
    this.octave = Math.floor(midi / 12) - 1;
    this.cursorTime += dur;
    this.render();
    const accStr = accidental === 1 ? "#" : accidental === -1 ? "b" : "";
    this.announce(`curve note ${letter}${accStr}${this.octave}${clamped ? ", clamped" : ""}, ${this._curveCapture.notes.length} notes captured`);
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
    if (this.mode === "melody") {
      if (this._curveCapture) this._closeCurveCapture();
      else this._openCurveCapture();
      return;
    }
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
      this.announce(`curve region set, ${region.time.toFixed(3)}s to ${region.endTime.toFixed(3)}s, add points with Shift+P`);
    } else {
      const region = makeCurveRegion({ time: this.cursorTime, endTime: this.cursorTime + 0.01, label: "curve region" });
      this.insert(region);
      this.openCurveRegionId = region.id;
      this.announce(`curve region started at ${this.cursorTime.toFixed(3)} seconds, move cursor and press Shift+C again to set the end`);
    }
  }

  _openCurveCapture() {
    this._curveCapture = { time: this.cursorTime, notes: [] };
    this.announce("curve capture started - type notes to pitch-bend through them, Shift+C again to close");
  }

  // Converts the captured notes into one continuous "carrier" event (so
  // there's actual haptic output, not just a modulation curve with
  // nothing to modulate) plus a sharpness curve region that eases between
  // each note's pitch - the same technique ahap_rs's .msh tied groups use
  // for `(DE)` syntax, just built live from keystrokes instead of parsed
  // from text.
  _closeCurveCapture() {
    const capture = this._curveCapture;
    this._curveCapture = null;
    if (!capture || capture.notes.length === 0) {
      this.announce("no notes entered, curve capture cancelled");
      return;
    }
    const totalDuration = capture.notes.reduce((s, n) => s + n.duration, 0);
    const anyAccented = capture.notes.some((n) => n.accented);
    const carrier = makeContinuous({
      time: capture.time,
      duration: totalDuration,
      intensity: anyAccented ? 0.85 : 0.7,
      sharpness: capture.notes[0].sharpness,
      label: `pitch-bend phrase (${capture.notes.length} notes)`,
    });
    this.insert(carrier);

    const points = [];
    const transition = 0.15; // fraction of each note's tail spent easing into the next
    const steps = 6;
    let cursor = 0;
    for (let i = 0; i < capture.notes.length; i++) {
      const { sharpness, duration } = capture.notes[i];
      const holdEnd = cursor + duration * (1 - transition);
      points.push({ time: cursor, value: sharpness });
      points.push({ time: holdEnd, value: sharpness });
      const next = capture.notes[i + 1];
      if (next) {
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const smooth = t * t * (3 - 2 * t);
          points.push({ time: holdEnd + (cursor + duration - holdEnd) * t, value: sharpness + (next.sharpness - sharpness) * smooth });
        }
      }
      cursor += duration;
    }
    const region = makeCurveRegion({
      time: capture.time,
      endTime: capture.time + totalDuration,
      sharpnessPoints: points,
      intensityPoints: [],
      label: "pitch-bend curve",
    });
    this.insert(region);
    this.render();
    this.announce(`curve set from ${capture.notes.length} notes, ${capture.time.toFixed(3)}s to ${(capture.time + totalDuration).toFixed(3)}s`);
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

  itemsInSelection() {
    if (!this.selection) return [];
    return this.items.filter(
      (it) => this.selection.trackIds.has(it.trackId) && it.time >= this.selection.start - 1e-9 && it.time <= this.selection.end + 1e-9
    );
  }

  copySelectionOrItem() {
    if (this.selection) {
      const items = this.itemsInSelection();
      if (!items.length) {
        this.announce("no items in the selection");
        return;
      }
      this.clipboard = { multi: true, anchor: this.selection.start, items: items.map((it) => JSON.parse(JSON.stringify(it))) };
      this.announce(`copied ${items.length} items`);
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

  cutSelectionOrItem() {
    if (this.selection) {
      const items = this.itemsInSelection();
      if (!items.length) {
        this.announce("no items in the selection");
        return;
      }
      this.clipboard = { multi: true, anchor: this.selection.start, items: items.map((it) => JSON.parse(JSON.stringify(it))) };
      const ids = new Set(items.map((it) => it.id));
      this.items = this.items.filter((it) => !ids.has(it.id));
      this.selection = null;
      this.render();
      this.announce(`cut ${items.length} items`);
      return;
    }
    const item = this.selectedItem();
    if (!item) {
      this.announce("nothing selected to cut");
      return;
    }
    this.clipboard = { multi: false, item: JSON.parse(JSON.stringify(item)) };
    this.deleteSelected();
  }

  pasteAtCursor() {
    if (!this.clipboard) {
      this.announce("clipboard empty");
      return;
    }
    if (this.clipboard.multi) {
      // Preserves each item's original track so multi-track cut/copy
      // reproduces the same structure at the new time.
      const shift = this.cursorTime - this.clipboard.anchor;
      const pasted = this.clipboard.items.map((src) => {
        const copy = cloneItem(src);
        copy.time = src.time + shift;
        if (copy.kind === "curveRegion") copy.endTime = src.endTime + shift;
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

  playFromBeginning() {
    this.audio.playFrom(this.items, 0, (item) => {
      this.select(item.id, { moveCursor: false, quiet: true });
    });
    this.announce("playing from the beginning");
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
      const inSelection =
        this.selection && this.selection.trackIds.has(item.trackId) && item.time >= this.selection.start - 1e-9 && item.time <= this.selection.end + 1e-9;
      if (inSelection) row.classList.add("in-range");
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
    this.dom.statusOctave.textContent = `Octave: ${this.octave} | Active track: ${this.trackName(this.activeTrackId)}`;
    this.dom.statusDuration.textContent =
      this.timeMode === "bars" ? `Zoom: ${ZOOM_LABEL[this.zoomLevel]}` : `Duration: ${DENOM_NAME[this.durationDenom]}`;
    this.dom.statusStep.textContent = `Time step: ${this.timeStep.toFixed(3)}s`;
    if (this.dom.statusRange) {
      this.dom.statusRange.textContent = this.selection
        ? `Range: ${this.selection.start.toFixed(3)}s-${this.selection.end.toFixed(3)}s (${this.selection.trackIds.size} track${this.selection.trackIds.size === 1 ? "" : "s"})`
        : "Range: none";
    }
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
    this.dom.popupCancel.textContent = "Cancel";
    this.dom.popupOk.hidden = !!infoOnly;
    this.dom.popup.hidden = false;
    this._popupReturnFocus = document.activeElement;
    // Value-entry popups are forms: focusing the first field is expected
    // and lets a screen reader announce its label immediately.
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
    // This is a read-only dialog, not a form: focus the dialog box itself
    // (tabindex="-1") rather than the Close button, so a screen reader
    // starts reading from the title and the list can be browsed with
    // arrow keys right away, without needing Ctrl+Home first.
    if (this.dom.popupBox) this.dom.popupBox.focus();
    else this.dom.popupCancel.focus();
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

    // Left / Right: cursor step, selection extend, or bar jump -----------
    if (k === "ArrowLeft" || k === "ArrowRight") {
      const dir = k === "ArrowLeft" ? -1 : 1;
      e.preventDefault();
      if (e.ctrlKey && e.shiftKey) this.extendSelectionByBar(dir);
      else if (e.ctrlKey) this.moveCursorByBar(dir);
      else if (e.shiftKey) this.extendSelectionBySteps(dir);
      else this.moveCursorBy(dir);
      return;
    }

    // Up / Down: track switch, track-selection extend, octave, or nudge --
    if (k === "ArrowUp" || k === "ArrowDown") {
      const dir = k === "ArrowUp" ? -1 : 1;
      e.preventDefault();
      if (e.ctrlKey) {
        this._shiftOctave(-dir); // ArrowUp (dir=-1) raises the octave, ArrowDown lowers it
      } else if (e.shiftKey) {
        if (k === "ArrowDown") this.extendSelectionTrackDown();
        else this.extendSelectionTrackUp();
      } else {
        this.switchActiveTrack(dir);
      }
      return;
    }

    if (k === "PageUp") {
      e.preventDefault();
      if (e.shiftKey) this.nudgeSelected("sharpness", 0.05);
      else this.nudgeSelected("intensity", 0.05);
      return;
    }
    if (k === "PageDown") {
      e.preventDefault();
      if (e.shiftKey) this.nudgeSelected("sharpness", -0.05);
      else this.nudgeSelected("intensity", -0.05);
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
      this.selection = null;
      this.cursorTime = 0;
      this.render();
      this.announce("cursor at start, 0 seconds");
      return;
    }
    if (k === "End") {
      e.preventDefault();
      this.selection = null;
      this.cursorTime = this.patternEnd();
      this.render();
      this.announce(`cursor at end, ${this.cursorTime.toFixed(3)} seconds`);
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
      this.copySelectionOrItem();
      return;
    }
    if (e.ctrlKey && k.toLowerCase() === "x") {
      e.preventDefault();
      this.cutSelectionOrItem();
      return;
    }
    if (e.ctrlKey && k.toLowerCase() === "v") {
      e.preventDefault();
      this.pasteAtCursor();
      return;
    }

    // Playback ------------------------------------------------------------
    if (e.ctrlKey && e.shiftKey && k === " ") {
      e.preventDefault();
      this.playFromBeginning();
      return;
    }
    if (e.ctrlKey && k === " ") {
      e.preventDefault();
      this.playFromCursor();
      return;
    }
    if (k === "Escape") {
      e.preventDefault();
      if (!this.clearSelection()) this.stopPlayback();
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

    // Duration digits (MuseScore layout) and rest -------------------------
    if (/^[1-9]$/.test(k) && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) {
        this.setZoomLevel(parseInt(k, 10));
      } else {
        this.durationDenom = KEY_TO_DENOM[k];
        this.render();
        this.announce(`duration ${DENOM_NAME[this.durationDenom]}`);
      }
      return;
    }
    if (k === "0" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.insertRestCurrentDuration();
      return;
    }

    // Accent ------------------------------------------------------------
    if (k === "!") {
      e.preventDefault();
      this.pendingAccent = true;
      this.announce("accent armed for next note");
      return;
    }

    // Curve region start/close - global, works in any mode. In Melody
    // mode this starts/stops note-capture (see startOrCloseCurveRegion);
    // elsewhere it's the manual empty-region + Shift+P point flow. Note
    // this claims Shift+C everywhere, so a literal C-sharp in Melody mode
    // needs its enharmonic equivalent: Alt+D (D-flat = C-sharp).
    if (k.toLowerCase() === "c" && e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      this.startOrCloseCurveRegion();
      return;
    }

    // Normal mode: transient / continuous / envelope ----------------------
    if (this.mode === "normal") {
      if (k.toLowerCase() === "t" && !e.ctrlKey) {
        e.preventDefault();
        this.insertRawTransient();
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
      if (this._curveCapture) this.insertCurveCaptureNote(letter, accidental);
      else this.insertMelodyNote(letter, accidental);
      return;
    }
    if (this.mode === "drums" && /^[ktshxocrKTSHXOCR]$/.test(k)) {
      e.preventDefault();
      this.insertDrum(k.toLowerCase());
      return;
    }
  }
}
