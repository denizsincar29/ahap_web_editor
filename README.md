# ahap_web_editor

An accessible, keyboard-first, static (HTML/CSS/JS, no build step) web editor
for Apple Haptic and Audio Pattern (`.ahap`) files, built as a web companion
to [`ahap_rs`](https://github.com/denizsincar29/ahap_rs). No dependencies,
no bundler - open `index.html` or serve the folder with any static file
server.

## What it does

- **Import MIDI** - a from-scratch Standard MIDI File reader plus a JS port
  of `ahap_rs`'s `midi2ahap` rules: channel 10 (GM drums) gets
  instrument-shaped events (kick/tom = felt punch, snare/hats = crisp
  transient, cymbals/open hi-hat = ringing tail), melodic notes map pitch to
  sharpness, and GM2 sound-controller CCs (73 attack, 72 release, 75 decay,
  74 brightness) steer envelope/sharpness the same way they do in `ahap_rs`.
  Simplification vs. the Rust version: out-of-range low notes are clamped
  into the 80-230 Hz haptic range instead of being split into a root+fourth
  pair.
- **Import `.msh`** (Music Haptics DSL) - a faithful JS port of `ahap_rs`'s
  parser (`src/msh.rs`): `@melody`/`@drums`/`@events` sections, note letters
  with `#`/`b`, accents (`!`), octave shifts (`<`/`>`), tied/pitch-bend
  groups (`(DE)`), the drum letter kit, and the `@events` line DSL
  (`transient`/`continuous`/`repeat`/`curve`). Verified against `ahap_rs`'s
  own `examples/mario.msh` -> the sharpness/intensity/timing values match
  `examples/mario.ahap` exactly.
- **Import/export `.ahap`** - reads and writes the real AHAP JSON shape
  (`Version`/`Metadata`/`Pattern`, `HapticTransient`/`HapticContinuous`
  events, `ParameterCurve` control points), so files round-trip with
  `ahap_rs` and with Apple's own tooling.
- **Manual keyboard authoring** - an accessible item list (`role="listbox"`,
  `aria-activedescendant`, live-region announcements for every action) with:
  - `Left`/`Right` moves a time cursor by a step; `Ctrl+Left`/`Ctrl+Right`
    moves the selection between existing items.
  - Three insert modes: **Melody** (letters `A`-`G`, `Shift` for sharp,
    `Alt` for flat, `1`-`6` for note duration, `Ctrl+Up`/`Ctrl+Down` for
    octave, `!` to arm an accent), **Drums** (`k t s h x o c r`), and **Raw**
    (`t`/`c` for a plain transient/continuous event).
  - `Enter` opens a full form for precise numeric editing (time, duration,
    intensity, sharpness, attack/decay/release, a free-text label used for
    screen reader announcements).
  - `Delete`/`Backspace` to delete, `Ctrl+C`/`Ctrl+V` to copy/paste at the
    cursor, `Up`/`Down` (and `Shift+Up`/`Shift+Down`) to nudge intensity/
    sharpness without opening the form.
  - A collapsible keyboard-shortcuts panel (`Keyboard shortcuts` button)
    documents all of the above in the page itself.
- **Triangle-wave audio preview** - Web Audio, no device haptics required:
  sharpness maps to pitch (haptic 80-230 Hz range scaled up for audibility),
  intensity to gain, attack/decay/release shape the envelope, and
  `HapticSharpnessControl`/`HapticIntensityControl` curves are played back
  as pitch/gain automation. `P` previews the selected item alone,
  `Ctrl+Space` plays the whole pattern from the cursor.

## About the "over-the-air" WebSocket idea

There's an experimental "Send over WebSocket" panel at the bottom of the
page (connect to any `ws://`/`wss://` URL, it streams each event as JSON at
its own scheduled time). As far as I could find, there isn't a public app
that receives `.ahap` over a socket and plays it back as real haptics - so
this is there for you to point at your own receiver later (a phone app, an
ESP32 haptic driver, whatever), not a ready-made playback pipeline.

## Files

```
index.html        - page shell, toolbar, accessible item list, edit form
css/style.css      - dark theme, focus-visible outlines, screen-reader-only utility classes
js/ahap.js         - AHAP data model, JSON export/import, freq<->sharpness helpers
js/msh.js          - .msh (Music Haptics) parser, ported from ahap_rs/src/msh.rs
js/midi.js         - Standard MIDI File reader + midi2ahap-style conversion
js/audio.js        - Web Audio triangle-wave preview engine
js/editor.js        - editor state machine: selection, cursor, keyboard handling, a11y announcements
js/main.js          - DOM wiring, file import/export, WebSocket sender
```

## Known simplifications

- MIDI import clamps out-of-range low notes instead of splitting them into
  a root+fourth pair (the Rust `midi2ahap` does the latter).
- `.msh` metadata directives (`@name`, `@description`) are parsed but not
  surfaced in the editor UI yet - they only matter for `.ahap` export
  metadata today, and the editor writes its own generic metadata instead.
- `.msh` export from the editor always writes the raw `@events` form
  (one line per item) rather than trying to re-derive melody/drum notation
  from sharpness/intensity values, so nothing is lost on export, but the
  output isn't as pretty as a hand-written `.msh` file.
