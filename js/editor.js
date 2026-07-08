import {
  makeTransient,
  makeContinuous,
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

    this._bindToolbar();
    this._bindListKeys();
    this._bindForm();
    this.render();
  }

  // ---- announcements -------------------------------------------------

  announce(msg) {
    const el = this.dom.liveStatus;
    el.textContent = "";
    // Forces NVDA/JAWS/VoiceOver to re-announce even if the text repeats.
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

  selectedItem() {
    return this.items.find((it) => it.id === this.selectedId) || null;
  }

  selectedIndex() {
    const list = this.sorted();
    return list.findIndex((it) => it.id === this.selectedId);
  }

  patternEnd() {
    return this.items.reduce((max, it) => Math.max(max, itemEndTime(it)), 0);
  }

  loadItems(items, { announceMsg } = {}) {
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
    this.announce(`cursor ${this.cursorTime.toFixed(3)} seconds`);
  }

  moveSelectionAdjacent(direction) {
    const list = this.sorted();
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

  // ---- describe for screen reader ---------------------------------------

  describeItem(item) {
    const kind = item.kind === "transient" ? "transient" : item.kind === "continuous" ? "continuous" : "curve";
    const label = item.label ? `${item.label}, ` : "";
    if (item.kind === "curve") {
      return `${label}${kind} at ${item.time.toFixed(3)}s, ${item.points.length} points, parameter ${item.parameterId}`;
    }
    const dur = item.kind === "continuous" ? `, duration ${item.duration.toFixed(3)}s` : "";
    return `${label}${kind} at ${item.time.toFixed(3)}s${dur}, intensity ${item.intensity.toFixed(2)}, sharpness ${item.sharpness.toFixed(2)}`;
  }

  // ---- insertion ---------------------------------------------------------

  insert(item) {
    this.items.push(item);
    this.selectedId = item.id;
    this.render();
    return item;
  }

  noteDurationSeconds() {
    const bpm = parseFloat(this.dom.fTempo.value) || 120;
    return (4.0 / this.durationDenom) * (60.0 / bpm);
  }

  consumeAccent() {
    const a = this.pendingAccent;
    this.pendingAccent = false;
    return a;
  }

  insertRest() {
    const dur = this.noteDurationSeconds();
    this.cursorTime += dur;
    this.render();
    this.announce(`rest, cursor now ${this.cursorTime.toFixed(3)} seconds`);
  }

  insertMelodyNote(letter, accidental) {
    const dur = this.noteDurationSeconds();
    let freq = noteFreq(letter, accidental, this.octave);
    const clamped = freq < FREQ_MIN || freq > FREQ_MAX;
    const sharpness = freqToSharpness(freq);
    const accented = this.consumeAccent();
    let intensity = 0.6 + (accented ? 0.15 : 0);
    intensity = Math.min(1, intensity);
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
    let intensity = 0.7 + (accented ? 0.15 : 0);
    intensity = Math.min(1, intensity);
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

  insertRawContinuous() {
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
    const list = this.sorted();
    this.selectedId = list.length ? list[Math.min(idx, list.length - 1)].id : null;
    this.render();
    this.announce(`deleted ${item.label || item.kind}`);
  }

  copySelected() {
    const item = this.selectedItem();
    if (!item) {
      this.announce("nothing selected to copy");
      return;
    }
    this.clipboard = JSON.parse(JSON.stringify(item));
    this.announce(`copied ${item.label || item.kind}`);
  }

  pasteAtCursor() {
    if (!this.clipboard) {
      this.announce("clipboard empty");
      return;
    }
    const copy = cloneItem(this.clipboard);
    const offset = this.cursorTime - copy.time;
    copy.time = this.cursorTime;
    if (copy.kind === "curve") {
      // control point times stay relative, only the anchor moves
    }
    this.insert(copy);
    this.announce(`pasted ${copy.label || copy.kind} at ${this.cursorTime.toFixed(3)} seconds`);
    void offset;
  }

  nudgeSelected(field, delta) {
    const item = this.selectedItem();
    if (!item || item.kind === "curve") {
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

  // ---- rendering ------------------------------------------------------

  render() {
    const list = this.sorted();
    const container = this.dom.itemList;
    container.innerHTML = "";
    list.forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = "item-row";
      row.id = "item-" + item.id;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(item.id === this.selectedId));
      const kindLabel = item.kind === "transient" ? "Transient" : item.kind === "continuous" ? "Continuous" : "Curve";
      row.innerHTML = `
        <span class="col-index">${idx + 1}</span>
        <span class="col-time">${item.time.toFixed(3)}s</span>
        <span class="col-kind">${kindLabel}</span>
        <span class="col-intensity">${item.kind === "curve" ? "" : "I " + item.intensity.toFixed(2)}</span>
        <span class="col-sharpness">${item.kind === "curve" ? "" : "S " + item.sharpness.toFixed(2)}</span>
        <span class="col-label">${item.label || ""}</span>
      `;
      row.addEventListener("click", () => {
        this.dom.itemList.focus();
        this.select(item.id);
      });
      container.appendChild(row);
    });

    this.dom.emptyHint.hidden = list.length > 0;
    this.dom.itemList.setAttribute("aria-activedescendant", this.selectedId ? "item-" + this.selectedId : "");

    this.dom.statusTime.textContent = `Cursor: ${this.cursorTime.toFixed(3)}s`;
    const sel = this.selectedItem();
    const idx = this.selectedIndex();
    this.dom.statusSelection.textContent = sel ? `Selected: item ${idx + 1} of ${list.length}` : "Selected: none";
    this.dom.statusCount.textContent = `${list.length} item${list.length === 1 ? "" : "s"}`;
    this.dom.statusOctave.textContent = `Octave: ${this.octave}`;
    this.dom.statusDuration.textContent = `Duration: ${DENOM_NAME[this.durationDenom]}`;
    this.dom.statusStep.textContent = `Time step: ${this.timeStep.toFixed(3)}s`;
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
    this.dom.fIntensity.value = item.kind === "curve" ? "" : item.intensity;
    this.dom.fSharpness.value = item.kind === "curve" ? "" : item.sharpness;
    this.dom.fAttack.value = item.attack ?? "";
    this.dom.fDecay.value = item.decay ?? "";
    this.dom.fRelease.value = item.release ?? "";
    this.dom.fLabel.value = item.label || "";
    this.dom.fIntensity.disabled = item.kind === "curve";
    this.dom.fSharpness.disabled = item.kind === "curve";
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
    if (item.kind !== "curve") {
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
      this.copySelected();
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
      this.stopPlayback();
      return;
    }
    if (k.toLowerCase() === "p" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.previewSelected();
      return;
    }

    // Duration digits ------------------------------------------------------
    if (/^[1-6]$/.test(k) && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.durationDenom = KEY_TO_DENOM[k];
      this.render();
      this.announce(`duration ${DENOM_NAME[this.durationDenom]}`);
      return;
    }

    // Accent ------------------------------------------------------------
    if (k === "!") {
      e.preventDefault();
      this.pendingAccent = true;
      this.announce("accent armed for next note");
      return;
    }

    // Rest ------------------------------------------------------------
    if (k === "-") {
      e.preventDefault();
      this.insertRest();
      return;
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
    if (this.mode === "raw" && k.toLowerCase() === "t" && !e.ctrlKey) {
      e.preventDefault();
      this.insertRawTransient();
      return;
    }
    if (this.mode === "raw" && k.toLowerCase() === "c" && !e.ctrlKey) {
      e.preventDefault();
      this.insertRawContinuous();
      return;
    }
  }
}
