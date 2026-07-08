// Core AHAP (Apple Haptic and Audio Pattern) data model.
// Mirrors ahap_rs's data model (src/lib.rs, src/curves.rs) closely enough
// that JSON produced here round-trips with Apple's format and with ahap_rs.

export const EVENT_TRANSIENT = "HapticTransient";
export const EVENT_CONTINUOUS = "HapticContinuous";

export const PARAM_INTENSITY = "HapticIntensity";
export const PARAM_SHARPNESS = "HapticSharpness";
export const PARAM_ATTACK = "HapticAttackTime";
export const PARAM_DECAY = "HapticDecayTime";
export const PARAM_RELEASE = "HapticReleaseTime";

export const CURVE_INTENSITY = "HapticIntensityControl";
export const CURVE_SHARPNESS = "HapticSharpnessControl";

export const FREQ_MIN = 80.0;
export const FREQ_MAX = 230.0;

let idCounter = 0;
export function nextId() {
  idCounter += 1;
  return "it" + idCounter + "_" + Math.random().toString(36).slice(2, 7);
}

/** Converts a frequency in Hz to a sharpness value in [0,1] using the same
 * log mapping ahap_rs uses between 80 Hz and 230 Hz. Always clamps
 * (normalize=true in the Rust version) since this editor never wants a hard
 * error, just a clamped-and-warned result. */
export function freqToSharpness(freq) {
  const clamped = Math.min(FREQ_MAX, Math.max(FREQ_MIN, freq));
  const r = (Math.log(clamped) - Math.log(FREQ_MIN)) / (Math.log(FREQ_MAX) - Math.log(FREQ_MIN));
  return Math.min(1, Math.max(0, r));
}

/** Inverse of freqToSharpness - used by audio preview to turn a sharpness
 * value back into an audible-ish pitch for the triangle wave. */
export function sharpnessToFreq(sharpness) {
  const s = Math.min(1, Math.max(0, sharpness));
  return FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, s);
}

/** Semitone offset from C, same table as ahap_rs note_semitone. */
const NOTE_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Frequency in Hz for a note letter + accidental (+1 sharp, -1 flat, 0
 * natural) at a scientific-pitch octave (C4 = middle C = MIDI 60). */
export function noteFreq(letter, accidental, octave) {
  const semitone = (NOTE_SEMITONE[letter] ?? 0) + accidental;
  const midiNumber = (octave + 1) * 12 + semitone;
  return 440.0 * Math.pow(2, (midiNumber - 69) / 12);
}

/** MIDI note number -> Hz, standard A4=440 equal temperament. */
export function midiNoteToFreq(midiNumber) {
  return 440.0 * Math.pow(2, (midiNumber - 69) / 12);
}

// ---- Editable item model -------------------------------------------------
//
// The editor works over a flat array of "items", each either an event
// (transient/continuous) or a parameter curve. This is richer than the raw
// AHAP Pattern array (extra `id`/`label` bookkeeping for the UI + screen
// reader), and gets flattened to/from real AHAP JSON at import/export time.

export function makeTransient({ time, intensity = 1.0, sharpness = 0.5, attack = null, decay = null, release = null, label = null }) {
  return { id: nextId(), kind: "transient", time, intensity, sharpness, attack, decay, release, label };
}

export function makeContinuous({ time, duration, intensity = 1.0, sharpness = 0.5, attack = null, decay = null, release = null, label = null }) {
  return { id: nextId(), kind: "continuous", time, duration, intensity, sharpness, attack, decay, release, label };
}

export function makeCurve({ time, parameterId, points, label = null }) {
  // points: [{time, value}] where time is relative to the curve's own time.
  return { id: nextId(), kind: "curve", time, parameterId, points, label };
}

export function cloneItem(item) {
  const copy = JSON.parse(JSON.stringify(item));
  copy.id = nextId();
  return copy;
}

export function itemEndTime(item) {
  if (item.kind === "continuous") return item.time + item.duration;
  if (item.kind === "curve") {
    const last = item.points.length ? item.points[item.points.length - 1].time : 0;
    return item.time + last;
  }
  return item.time;
}

export function sortItems(items) {
  return items.slice().sort((a, b) => a.time - b.time);
}

// ---- Export: items[] -> AHAP JSON object ---------------------------------

function envelopeParams(item) {
  const params = [];
  if (item.attack !== null && item.attack !== undefined) params.push({ ParameterID: PARAM_ATTACK, ParameterValue: item.attack });
  if (item.decay !== null && item.decay !== undefined) params.push({ ParameterID: PARAM_DECAY, ParameterValue: item.decay });
  if (item.release !== null && item.release !== undefined) params.push({ ParameterID: PARAM_RELEASE, ParameterValue: item.release });
  return params;
}

export function itemsToAhap(items, meta = {}) {
  const pattern = sortItems(items).map((item) => {
    if (item.kind === "curve") {
      return {
        ParameterCurve: {
          ParameterID: item.parameterId,
          Time: item.time,
          ParameterCurveControlPoints: item.points.map((p) => ({ Time: p.time, ParameterValue: p.value })),
        },
      };
    }
    const params = [
      { ParameterID: PARAM_INTENSITY, ParameterValue: item.intensity },
      { ParameterID: PARAM_SHARPNESS, ParameterValue: item.sharpness },
      ...envelopeParams(item),
    ];
    const event = {
      Time: item.time,
      EventType: item.kind === "transient" ? EVENT_TRANSIENT : EVENT_CONTINUOUS,
      EventParameters: params,
    };
    if (item.kind === "continuous") event.EventDuration = item.duration;
    return { Event: event };
  });

  return {
    Version: 1.0,
    Metadata: {
      Project: meta.project || "Basis",
      Created: meta.created || (Date.now() / 1000).toFixed(6),
      Description: meta.description || "made in ahap web editor",
      "Created By": meta.createdBy || "ahap web editor",
    },
    Pattern: pattern,
  };
}

export function ahapToJson(ahap, indent = true) {
  return indent ? JSON.stringify(ahap, null, 2) : JSON.stringify(ahap);
}

// ---- Import: AHAP JSON object -> items[] ----------------------------------

export function ahapToItems(ahapObj) {
  const items = [];
  for (const entry of ahapObj.Pattern || []) {
    if (entry.Event) {
      const e = entry.Event;
      const getParam = (id) => {
        const p = (e.EventParameters || []).find((p) => p.ParameterID === id);
        return p ? p.ParameterValue : undefined;
      };
      const base = {
        time: e.Time,
        intensity: getParam(PARAM_INTENSITY) ?? 1.0,
        sharpness: getParam(PARAM_SHARPNESS) ?? 0.5,
        attack: getParam(PARAM_ATTACK) ?? null,
        decay: getParam(PARAM_DECAY) ?? null,
        release: getParam(PARAM_RELEASE) ?? null,
      };
      if (e.EventType === EVENT_TRANSIENT) {
        items.push(makeTransient(base));
      } else {
        items.push(makeContinuous({ ...base, duration: e.EventDuration ?? 0.1 }));
      }
    } else if (entry.ParameterCurve) {
      const c = entry.ParameterCurve;
      items.push(
        makeCurve({
          time: c.Time,
          parameterId: c.ParameterID,
          points: (c.ParameterCurveControlPoints || []).map((p) => ({ time: p.Time, value: p.ParameterValue })),
        })
      );
    }
  }
  return items;
}

export function metaFromAhap(ahapObj) {
  const m = ahapObj.Metadata || {};
  return {
    project: m.Project,
    created: m.Created,
    description: m.Description,
    createdBy: m["Created By"],
  };
}
