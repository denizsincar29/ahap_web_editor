// JS port of ahap_rs's .msh (Music Haptics) text DSL parser (src/msh.rs).
// Produces editor items[] directly (see ahap.js) instead of going through
// an intermediate Rust-style Ahap struct, so note/drum labels survive for
// the screen reader.

import { makeContinuous, makeTransient, makeCurve, freqToSharpness, noteFreq, CURVE_SHARPNESS, CURVE_INTENSITY, FREQ_MIN, FREQ_MAX } from "./ahap.js";

const DYNAMICS_LEVEL = { pp: 2.0, p: 4.0, mp: 5.0, mf: 6.0, f: 8.0, forte: 8.0, ff: 10.0 };
const DURATION_DENOM = {
  whole: 1, "1": 1,
  half: 2, "2": 2,
  quarter: 4, "4": 4,
  eighth: 8, "8": 8,
  sixteenth: 16, "16": 16,
  thirtysecond: 32, "32": 32,
};
const NOTE_LETTERS = new Set(["A", "B", "C", "D", "E", "F", "G"]);

const DRUM_SHAPE = {
  k: { kind: "punch", sharpness: 0.3, name: "kick" },
  t: { kind: "punch", sharpness: 0.4, name: "tom" },
  s: { kind: "hit", sharpness: 0.6, name: "snare" },
  h: { kind: "hit", sharpness: 0.75, name: "closed hi-hat" },
  x: { kind: "hit", sharpness: 0.7, name: "clap" },
  o: { kind: "ring", sharpness: 0.65, name: "open hi-hat" },
  c: { kind: "ring", sharpness: 0.6, name: "crash" },
  r: { kind: "ring", sharpness: 0.55, name: "ride" },
};

function stripBlockComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "*") {
      let j = i + 2;
      while (j < source.length && !(source[j] === "*" && source[j + 1] === "/")) {
        out += source[j] === "\n" ? "\n" : " ";
        j++;
      }
      i = Math.min(j + 2, source.length);
    } else {
      out += source[i];
      i++;
    }
  }
  return out;
}

function beatToSeconds(bpm, beats) {
  return beats * (60.0 / bpm);
}

class CharCursor {
  constructor(line) {
    this.chars = Array.from(line);
    this.i = 0;
  }
  next() {
    if (this.i >= this.chars.length) return undefined;
    return this.chars[this.i++];
  }
  peek() {
    return this.chars[this.i];
  }
}

function readDurationDigits(cur, runningDefault, mode, setDefault) {
  let digits = "";
  while (cur.peek() !== undefined && /[0-9]/.test(cur.peek())) {
    digits += cur.next();
  }
  if (digits === "") return runningDefault;
  const denom = parseInt(digits, 10) || runningDefault;
  if (mode === "sticky") setDefault(denom);
  return denom;
}

function anchorAndEase(points, cursor, sharpness, holdEnd) {
  points.push({ time: cursor, value: sharpness });
  points.push({ time: holdEnd, value: sharpness });
}

function easeInOut(points, fromTime, fromVal, toTime, toVal, steps) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const smooth = t * t * (3 - 2 * t);
    points.push({ time: fromTime + (toTime - fromTime) * t, value: fromVal + (toVal - fromVal) * smooth });
  }
}

function parseKv(tokens) {
  const map = {};
  for (const tok of tokens) {
    const idx = tok.indexOf("=");
    if (idx < 0) throw new Error(`expected key=value, got "${tok}"`);
    map[tok.slice(0, idx)] = tok.slice(idx + 1);
  }
  return map;
}
function kvF(map, key, def) {
  if (map[key] !== undefined) {
    const v = parseFloat(map[key]);
    if (Number.isNaN(v)) throw new Error(`bad ${key} value: ${map[key]}`);
    return v;
  }
  if (def === undefined) throw new Error(`missing required key: ${key}`);
  return def;
}

function parseEventLine(line, items) {
  const tokens = line.split(/\s+/).filter(Boolean);
  const kind = tokens.shift();
  if (kind === "transient") {
    const map = parseKv(tokens);
    const t = kvF(map, "t");
    items.push(makeTransient({ time: t, intensity: kvF(map, "intensity", 1.0), sharpness: kvF(map, "sharpness", 0.5), label: "event: transient" }));
  } else if (kind === "continuous") {
    const map = parseKv(tokens);
    const t = kvF(map, "t");
    const duration = kvF(map, "duration");
    items.push(
      makeContinuous({
        time: t,
        duration,
        intensity: kvF(map, "intensity", 1.0),
        sharpness: kvF(map, "sharpness", 0.5),
        attack: map.attack !== undefined ? kvF(map, "attack") : null,
        decay: map.decay !== undefined ? kvF(map, "decay") : null,
        release: map.release !== undefined ? kvF(map, "release") : null,
        label: "event: continuous",
      })
    );
  } else if (kind === "repeat") {
    const subKind = tokens.shift();
    const map = parseKv(tokens);
    const t = kvF(map, "t");
    const count = Math.round(kvF(map, "count"));
    const step = kvF(map, "step");
    const intensity = kvF(map, "intensity", 1.0);
    const sharpness = kvF(map, "sharpness", 0.5);
    for (let i = 0; i < count; i++) {
      const time = t + i * step;
      if (subKind === "transient") {
        items.push(makeTransient({ time, intensity, sharpness, label: `event: repeat transient ${i + 1}/${count}` }));
      } else if (subKind === "continuous") {
        const duration = kvF(map, "duration", 0.1);
        items.push(makeContinuous({ time, duration, intensity, sharpness, label: `event: repeat continuous ${i + 1}/${count}` }));
      } else {
        throw new Error(`unknown repeat sub-kind: ${subKind}`);
      }
    }
  } else if (kind === "curve") {
    const parameter = tokens.shift();
    const paramId = parameter === "intensity" ? CURVE_INTENSITY : parameter === "sharpness" ? CURVE_SHARPNESS : null;
    if (!paramId) throw new Error(`unknown curve parameter: ${parameter}`);
    const map = parseKv(tokens);
    const t = kvF(map, "t");
    const duration = kvF(map, "duration");
    const from = kvF(map, "from");
    const to = kvF(map, "to");
    const steps = Math.round(kvF(map, "steps", 10));
    const points = [];
    for (let i = 0; i < steps; i++) {
      const frac = (i + 1) / steps;
      points.push({ time: duration * frac, value: from + (to - from) * frac });
    }
    items.push(makeCurve({ time: t, parameterId: paramId, points, label: `event: ${parameter} curve` }));
  } else {
    throw new Error(`unknown @events line kind: ${kind}`);
  }
}

/** Parses .msh source text into editor items[]. Throws Error with a
 * human-readable message on malformed input (caller should surface it). */
export function parseMsh(source) {
  source = stripBlockComments(source);
  let bpm = 120.0;
  let octave = 4;
  let defaultDenominator = 8;
  let durationMode = "temporary";
  let accentDelta = 0.15;
  let dynamics = 6.0;
  let curveTransition = 0.1;
  let section = "none";
  let time = 0.0;
  const items = [];
  const warnings = [];

  const lines = source.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    let raw = lines[lineNo];
    const cut = raw.indexOf("//");
    const line = (cut >= 0 ? raw.slice(0, cut) : raw).trim();
    if (line === "") continue;

    if (line.startsWith("@")) {
      let rest = line.slice(1).trimStart();
      const wsIdx = rest.search(/\s/);
      let keyword, args;
      if (wsIdx >= 0) {
        keyword = rest.slice(0, wsIdx);
        args = rest.slice(wsIdx + 1).trim();
      } else {
        keyword = rest;
        args = "";
      }
      switch (keyword) {
        case "name":
        case "description":
          break; // metadata only, not needed by the editor model
        case "tempo":
          bpm = parseFloat(args);
          if (Number.isNaN(bpm)) throw new Error(`line ${lineNo + 1}: bad @tempo value: "${args}"`);
          break;
        case "octave":
          octave = parseInt(args, 10);
          if (Number.isNaN(octave)) throw new Error(`line ${lineNo + 1}: bad @octave value: "${args}"`);
          break;
        case "duration":
          if (!(args in DURATION_DENOM)) throw new Error(`line ${lineNo + 1}: unknown @duration value: "${args}"`);
          defaultDenominator = DURATION_DENOM[args];
          break;
        case "duration-mode":
          if (args === "sticky" || args === "persistent") durationMode = "sticky";
          else if (args === "temporary" || args === "oneshot" || args === "once") durationMode = "temporary";
          else throw new Error(`line ${lineNo + 1}: unknown @duration-mode value: "${args}"`);
          break;
        case "accent-velocity":
          accentDelta = parseFloat(args);
          if (Number.isNaN(accentDelta)) throw new Error(`line ${lineNo + 1}: bad @accent-velocity value: "${args}"`);
          break;
        case "curve-transition":
        case "curve_transition":
          curveTransition = Math.min(1, Math.max(0, parseFloat(args)));
          break;
        case "melody":
          section = "melody";
          break;
        case "drums":
          section = "drums";
          break;
        case "events":
          section = "events";
          break;
        default:
          if (keyword in DYNAMICS_LEVEL) dynamics = DYNAMICS_LEVEL[keyword];
          else throw new Error(`line ${lineNo + 1}: unknown directive: @${keyword}`);
      }
      continue;
    }

    if (section === "events") {
      try {
        parseEventLine(line, items);
      } catch (e) {
        throw new Error(`line ${lineNo + 1}: ${e.message}`);
      }
      continue;
    }

    const cur = new CharCursor(line);
    let c;
    while ((c = cur.next()) !== undefined) {
      if (/\s/.test(c)) continue;
      let accented = c === "!";
      if (accented) {
        c = cur.next();
        if (c === undefined) throw new Error(`line ${lineNo + 1}: "!" at end of line with nothing to accent`);
      }

      if (c === "<") {
        octave -= 1;
        continue;
      }
      if (c === ">") {
        octave += 1;
        continue;
      }

      if (c === "-") {
        const denom = readDurationDigits(cur, defaultDenominator, durationMode, (d) => (defaultDenominator = d));
        time += beatToSeconds(bpm, 4.0 / denom);
        continue;
      }

      if (c === "(") {
        if (section !== "melody") throw new Error(`line ${lineNo + 1}: tied groups are only valid inside @melody`);
        const notes = []; // {sharpness, duration, freq}
        let nc;
        for (;;) {
          nc = cur.next();
          if (nc === undefined) throw new Error(`line ${lineNo + 1}: unterminated "(" tied group`);
          if (nc === ")") break;
          if (/\s/.test(nc)) continue;
          if (!NOTE_LETTERS.has(nc)) throw new Error(`line ${lineNo + 1}: unknown symbol inside tied group: "${nc}"`);
          let accidental = 0;
          if (cur.peek() === "#") {
            cur.next();
            accidental = 1;
          } else if (cur.peek() === "b") {
            cur.next();
            accidental = -1;
          }
          const denom = readDurationDigits(cur, defaultDenominator, durationMode, (d) => (defaultDenominator = d));
          const duration = beatToSeconds(bpm, 4.0 / denom);
          let freq = noteFreq(nc, accidental, octave);
          if (freq < FREQ_MIN || freq > FREQ_MAX) {
            warnings.push(`line ${lineNo + 1}: tied note ${nc} at octave ${octave} (${freq.toFixed(1)} Hz) clamped to haptic range`);
          }
          notes.push({ sharpness: freqToSharpness(freq), duration });
        }
        if (notes.length === 0) throw new Error(`line ${lineNo + 1}: empty "()" tied group`);

        const totalDuration = notes.reduce((s, n) => s + n.duration, 0);
        let intensity = dynamics / 10.0;
        if (accented) intensity += accentDelta;
        intensity = Math.min(1, Math.max(0, intensity));

        items.push(makeContinuous({ time, duration: totalDuration, intensity, sharpness: notes[0].sharpness, label: "tied melody group" }));

        const points = [];
        let cursor = 0.0;
        for (let i = 0; i < notes.length; i++) {
          const { sharpness, duration } = notes[i];
          const holdEnd = cursor + duration * (1 - curveTransition);
          anchorAndEase(points, cursor, sharpness, holdEnd);
          if (notes[i + 1]) {
            easeInOut(points, holdEnd, sharpness, cursor + duration, notes[i + 1].sharpness, 6);
          }
          cursor += duration;
        }
        items.push(makeCurve({ time, parameterId: CURVE_SHARPNESS, points, label: "tied group pitch-bend curve" }));

        time += totalDuration;
        continue;
      }

      if (section === "melody") {
        if (!NOTE_LETTERS.has(c)) throw new Error(`line ${lineNo + 1}: unknown symbol in melody body: "${c}"`);
        let accidental = 0;
        if (cur.peek() === "#") {
          cur.next();
          accidental = 1;
        } else if (cur.peek() === "b") {
          cur.next();
          accidental = -1;
        }
        const denom = readDurationDigits(cur, defaultDenominator, durationMode, (d) => (defaultDenominator = d));
        const duration = beatToSeconds(bpm, 4.0 / denom);
        let freq = noteFreq(c, accidental, octave);
        if (freq < FREQ_MIN || freq > FREQ_MAX) {
          warnings.push(`line ${lineNo + 1}: note ${c} at octave ${octave} (${freq.toFixed(1)} Hz) clamped to haptic range`);
        }
        const sharpness = freqToSharpness(freq);
        let intensity = dynamics / 10.0;
        if (accented) intensity += accentDelta;
        intensity = Math.min(1, Math.max(0, intensity));
        const noteName = c + (accidental === 1 ? "#" : accidental === -1 ? "b" : "") + octave;
        items.push(makeContinuous({ time, duration, intensity, sharpness, label: `note ${noteName}${accented ? " (accented)" : ""}` }));
        time += duration;
      } else if (section === "drums") {
        const denom = readDurationDigits(cur, defaultDenominator, durationMode, (d) => (defaultDenominator = d));
        const duration = beatToSeconds(bpm, 4.0 / denom);
        const shape = DRUM_SHAPE[c.toLowerCase()];
        if (!shape) throw new Error(`line ${lineNo + 1}: unknown symbol in drum body: "${c}"`);
        let intensity = dynamics / 10.0;
        if (accented) intensity += accentDelta;
        intensity = Math.min(1, Math.max(0, intensity));
        const label = `${shape.name}${accented ? " (accented)" : ""}`;

        if (shape.kind === "punch") {
          items.push(
            makeContinuous({ time, duration, intensity, sharpness: shape.sharpness, attack: 0.0, decay: duration * 0.6, release: duration * 0.4, label })
          );
        } else if (shape.kind === "hit") {
          items.push(makeTransient({ time, intensity, sharpness: shape.sharpness, label }));
        } else if (shape.kind === "ring") {
          items.push(makeContinuous({ time, duration, intensity, sharpness: shape.sharpness, label }));
          const points = [];
          easeInOut(points, 0, 1.0, duration, 0.0, 6);
          items.push(makeCurve({ time, parameterId: CURVE_INTENSITY, points, label: `${shape.name} decay curve` }));
        }
        time += duration;
      } else {
        throw new Error(`line ${lineNo + 1}: note/drum symbol before @melody, @drums, or @events section`);
      }
    }
  }

  return { items, warnings };
}
