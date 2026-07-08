// Minimal Standard MIDI File (SMF) reader + a simplified port of ahap_rs's
// midi2ahap conversion (see readme.md "midi2ahap" section):
//   - channel 10 (index 9, the GM drum channel) gets instrument-appropriate
//     shapes: kicks/toms a short felt punch, cymbals/open hi-hat a ringing
//     tail, snares/sticks a crisp transient.
//   - melodic notes map pitch -> sharpness via freqToSharpness.
//   - GM2 sound-controller CCs steer attack/decay/release/brightness:
//     CC73 attack, CC72 release, CC75 decay (as a 0-1 fraction of the
//     event's own duration), CC74 brightness -> +/-0.3 sharpness offset.
// Simplification vs. the Rust version: out-of-range low notes are clamped
// rather than split into a root+fourth pair.

import { makeTransient, makeContinuous, makeCurve, midiNoteToFreq, freqToSharpness, CURVE_INTENSITY } from "./ahap.js";

class ByteReader {
  constructor(buf) {
    this.view = new DataView(buf);
    this.pos = 0;
  }
  u8() {
    return this.view.getUint8(this.pos++);
  }
  u16() {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  bytes(n) {
    const b = new Uint8Array(this.view.buffer, this.pos, n);
    this.pos += n;
    return b;
  }
  str(n) {
    return Array.from(this.bytes(n)).map((b) => String.fromCharCode(b)).join("");
  }
  varLen() {
    let value = 0;
    let b;
    do {
      b = this.u8();
      value = (value << 7) | (b & 0x7f);
    } while (b & 0x80);
    return value;
  }
  eof() {
    return this.pos >= this.view.byteLength;
  }
}

function parseTrack(r, endPos) {
  const events = [];
  let tick = 0;
  let runningStatus = null;
  while (r.pos < endPos) {
    const delta = r.varLen();
    tick += delta;
    let status = r.u8();
    if (status < 0x80) {
      // running status: this byte was actually the first data byte
      r.pos -= 1;
      status = runningStatus;
    } else {
      runningStatus = status;
    }
    const type = status & 0xf0;
    const channel = status & 0x0f;

    if (status === 0xff) {
      const metaType = r.u8();
      const len = r.varLen();
      const data = r.bytes(len);
      events.push({ tick, meta: metaType, data });
    } else if (status === 0xf0 || status === 0xf1) {
      const len = r.varLen();
      r.bytes(len);
    } else if (type === 0x80 || type === 0x90) {
      const note = r.u8();
      const vel = r.u8();
      events.push({ tick, channel, type: type === 0x90 && vel > 0 ? "on" : "off", note, vel });
    } else if (type === 0xa0) {
      r.u8();
      r.u8(); // poly aftertouch, ignored
    } else if (type === 0xb0) {
      const cc = r.u8();
      const val = r.u8();
      events.push({ tick, channel, type: "cc", cc, val });
    } else if (type === 0xc0) {
      r.u8(); // program change
    } else if (type === 0xd0) {
      r.u8(); // channel aftertouch
    } else if (type === 0xe0) {
      r.u8();
      r.u8(); // pitch bend, ignored
    } else {
      // unknown status byte, bail out of this track to avoid an infinite loop
      break;
    }
  }
  return events;
}

/** Parses raw SMF bytes into { ticksPerQuarter, tracks: [[event...]] }. */
export function parseMidi(arrayBuffer) {
  const r = new ByteReader(arrayBuffer);
  if (r.str(4) !== "MThd") throw new Error("not a MIDI file (missing MThd header)");
  const headerLen = r.u32();
  const format = r.u16();
  const numTracks = r.u16();
  const division = r.u16();
  if (division & 0x8000) throw new Error("SMPTE time division is not supported");
  if (headerLen > 6) r.bytes(headerLen - 6);

  const tracks = [];
  for (let i = 0; i < numTracks; i++) {
    if (r.str(4) !== "MTrk") throw new Error(`track ${i}: missing MTrk header`);
    const len = r.u32();
    const end = r.pos + len;
    tracks.push(parseTrack(r, end));
    r.pos = end;
  }
  return { format, ticksPerQuarter: division, tracks };
}

/** Builds a sorted list of {tick, usecPerQuarter} tempo changes across all
 * tracks (tempo meta events can live on any track, most commonly track 0). */
function collectTempoMap(midi) {
  const changes = [{ tick: 0, usec: 500000 }]; // default 120 BPM
  for (const track of midi.tracks) {
    for (const ev of track) {
      if (ev.meta === 0x51 && ev.data.length === 3) {
        const usec = (ev.data[0] << 16) | (ev.data[1] << 8) | ev.data[2];
        changes.push({ tick: ev.tick, usec });
      }
    }
  }
  changes.sort((a, b) => a.tick - b.tick);
  return changes;
}

/** Converts a tick number to seconds by integrating elapsed time through
 * each tempo segment, matching ahap_rs's approach (see readme "Notable
 * differences" section) rather than assuming one tempo for the whole file. */
function makeTickToSeconds(tempoMap, ticksPerQuarter) {
  // Precompute cumulative seconds at each tempo-change tick.
  const cum = [{ tick: 0, seconds: 0, usec: tempoMap[0].usec }];
  for (let i = 1; i < tempoMap.length; i++) {
    const prev = cum[i - 1];
    const dtTicks = tempoMap[i].tick - prev.tick;
    const seconds = prev.seconds + (dtTicks * prev.usec) / (ticksPerQuarter * 1e6);
    cum.push({ tick: tempoMap[i].tick, seconds, usec: tempoMap[i].usec });
  }
  return (tick) => {
    let seg = cum[0];
    for (const c of cum) {
      if (c.tick <= tick) seg = c;
      else break;
    }
    const dtTicks = tick - seg.tick;
    return seg.seconds + (dtTicks * seg.usec) / (ticksPerQuarter * 1e6);
  };
}

const DRUM_SHAPE_BY_GM_NOTE = (note) => {
  // General MIDI percussion key map (channel 10), grouped like ahap_rs's
  // drum_shape: punch (kick/tom), hit (snare/hi-hat/sticks), ring (cymbals).
  if ([35, 36, 41, 43, 45, 47, 48, 50].includes(note)) return { kind: "punch", sharpness: note <= 36 ? 0.3 : 0.4 };
  if ([38, 40, 37, 39].includes(note)) return { kind: "hit", sharpness: 0.6 };
  if ([42, 44, 51, 53, 56, 60, 61, 62, 63, 64].includes(note)) return { kind: "hit", sharpness: 0.75 };
  if ([46, 49, 52, 55, 57, 59].includes(note)) return { kind: "ring", sharpness: 0.6 };
  return { kind: "hit", sharpness: 0.65 };
};

/** Converts a parsed MIDI structure into editor items[], following
 * ahap_rs's midi2ahap rules. `options.noDrums` drops channel 10 entirely;
 * `options.drumsAsMelody` treats it as melodic instead. */
export function midiToItems(midi, options = {}) {
  const tickToSeconds = makeTickToSeconds(collectTempoMap(midi), midi.ticksPerQuarter);
  const items = [];
  const warnings = [];

  // Global envelope/brightness state steered by GM2 CCs, shared across all
  // tracks/channels (matches ahap_rs: "values are global").
  let attackFrac = null;
  let decayFrac = null;
  let releaseFrac = null;
  let brightnessOffset = 0;

  // Flatten all tracks into one time-ordered event stream so CC changes
  // from one track affect notes converted afterward on any track.
  const allEvents = [];
  for (const track of midi.tracks) {
    for (const ev of track) allEvents.push(ev);
  }
  allEvents.sort((a, b) => a.tick - b.tick);

  const openNotes = new Map(); // key: channel*128+note -> {tick, vel}

  for (const ev of allEvents) {
    if (ev.type === "cc") {
      if (ev.cc === 73) attackFrac = ev.val / 127;
      else if (ev.cc === 72) releaseFrac = ev.val / 127;
      else if (ev.cc === 75) decayFrac = ev.val / 127;
      else if (ev.cc === 74) brightnessOffset = ((ev.val - 64) / 64) * 0.3;
      continue;
    }
    if (ev.type !== "on" && ev.type !== "off") continue;
    const key = ev.channel * 128 + ev.note;
    if (ev.type === "on") {
      openNotes.set(key, { tick: ev.tick, vel: ev.vel });
      continue;
    }
    const start = openNotes.get(key);
    if (!start) continue;
    openNotes.delete(key);

    const timeStart = tickToSeconds(start.tick);
    const timeEnd = tickToSeconds(ev.tick);
    const duration = Math.max(0.02, timeEnd - timeStart);
    const intensity = Math.min(1, Math.max(0.05, start.vel / 127));
    const isDrum = ev.channel === 9;

    if (isDrum && options.noDrums) continue;

    if (isDrum && !options.drumsAsMelody) {
      const shape = DRUM_SHAPE_BY_GM_NOTE(ev.note);
      const label = `drum note ${ev.note}`;
      if (shape.kind === "punch") {
        items.push(
          makeContinuous({
            time: timeStart,
            duration,
            intensity,
            sharpness: shape.sharpness,
            attack: attackFrac !== null ? attackFrac * duration : 0.0,
            decay: decayFrac !== null ? decayFrac * duration : duration * 0.6,
            release: releaseFrac !== null ? releaseFrac * duration : duration * 0.4,
            label,
          })
        );
      } else if (shape.kind === "hit") {
        items.push(makeTransient({ time: timeStart, intensity, sharpness: shape.sharpness, label }));
      } else {
        items.push(makeContinuous({ time: timeStart, duration, intensity, sharpness: shape.sharpness, label }));
        const points = [];
        for (let i = 1; i <= 6; i++) {
          const t = i / 6;
          const smooth = t * t * (3 - 2 * t);
          points.push({ time: duration * t, value: 1.0 + (0.0 - 1.0) * smooth });
        }
        items.push(makeCurve({ time: timeStart, parameterId: CURVE_INTENSITY, points, label: "drum decay curve" }));
      }
      continue;
    }

    // Melodic note: pitch -> sharpness, split into transient/continuous
    // depending on whether GM2 envelope CCs are steering it.
    let freq = midiNoteToFreq(ev.note);
    if (freq < 80 || freq > 230) {
      warnings.push(`note ${ev.note} (${freq.toFixed(1)} Hz) is outside 80-230 Hz, clamped`);
    }
    let sharpness = freqToSharpness(freq) + brightnessOffset;
    sharpness = Math.min(1, Math.max(0, sharpness));

    const env =
      attackFrac !== null || decayFrac !== null || releaseFrac !== null
        ? {
            attack: attackFrac !== null ? attackFrac * duration : 0.0,
            decay: decayFrac !== null ? decayFrac * duration : 0.0,
            release: releaseFrac !== null ? releaseFrac * duration : 0.0,
          }
        : { attack: null, decay: null, release: null };

    items.push(
      makeContinuous({
        time: timeStart,
        duration,
        intensity,
        sharpness,
        ...env,
        label: `MIDI note ${ev.note} ch${ev.channel + 1}`,
      })
    );
  }

  return { items, warnings };
}
