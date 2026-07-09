import { Editor } from "./editor.js";
import { itemsToAhap, ahapToItems, ahapToJson, metaFromAhap } from "./ahap.js";
import { parseMsh } from "./msh.js";
import { parseMidi, midiToItems } from "./midi.js";

function byId(id) {
  return document.getElementById(id);
}

const dom = {
  liveStatus: byId("liveStatus"),
  liveAlert: byId("liveAlert"),
  itemList: byId("itemList"),
  emptyHint: byId("emptyHint"),
  statusTime: byId("statusTime"),
  statusSelection: byId("statusSelection"),
  statusCount: byId("statusCount"),
  statusOctave: byId("statusOctave"),
  statusDuration: byId("statusDuration"),
  statusStep: byId("statusStep"),
  modeRadios: Array.from(document.querySelectorAll('input[name="insertMode"]')),
  fTempo: byId("fTempo"),
  btnPlayFromCursor: byId("btnPlayFromCursor"),
  btnPlaySelected: byId("btnPlaySelected"),
  btnStop: byId("btnStop"),
  btnHelp: byId("btnHelp"),
  helpPanel: byId("helpPanel"),
  detailForm: byId("detailForm"),
  editForm: byId("editForm"),
  editKind: byId("editKind"),
  rowDuration: byId("rowDuration"),
  fTime: byId("fTime"),
  fDuration: byId("fDuration"),
  fIntensity: byId("fIntensity"),
  fSharpness: byId("fSharpness"),
  fAttack: byId("fAttack"),
  fDecay: byId("fDecay"),
  fRelease: byId("fRelease"),
  fLabel: byId("fLabel"),
  btnCancelEdit: byId("btnCancelEdit"),
  popup: byId("popup"),
  popupBox: byId("popupBox"),
  popupTitle: byId("popupTitle"),
  popupForm: byId("popupForm"),
  popupFields: byId("popupFields"),
  popupOk: byId("popupOk"),
  popupCancel: byId("popupCancel"),
  trackList: byId("trackList"),
  btnAddTrack: byId("btnAddTrack"),
  btnDeleteTrack: byId("btnDeleteTrack"),
  chkSoloTrack: byId("chkSoloTrack"),
  statusRange: byId("statusRange"),
};

const editor = new Editor(dom);

// Focus the list on load so keyboard users can start typing right away.
dom.itemList.focus();

// Cancel the detail form with Escape from within any of its fields.
dom.detailForm.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    dom.detailForm.hidden = true;
    dom.itemList.focus();
    editor.announce("edit cancelled");
  }
});

// ---- File actions ---------------------------------------------------------

function downloadText(filename, text, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

byId("btnNew").addEventListener("click", () => {
  if (editor.items.length && !confirm("Discard the current pattern and start a new one?")) return;
  editor.loadItems([], { announceMsg: "new empty pattern" });
  dom.itemList.focus();
});

byId("btnSaveAhap").addEventListener("click", () => {
  const meta = { createdBy: "ahap web editor" };
  if (editor.timeMode === "bars") {
    meta.tempo = parseFloat(dom.fTempo.value) || 120;
    meta.timeSignature = `${editor.timeSig.num}/${editor.timeSig.den}`;
  }
  const ahap = itemsToAhap(editor.items, meta);
  downloadText("pattern.ahap", ahapToJson(ahap, true));
  editor.announce("saved pattern.ahap");
});

byId("btnExportMsh").addEventListener("click", () => {
  // Exports the raw @events form (not a musical re-derivation) so every
  // item, including manually tweaked envelopes and curves, round-trips.
  const lines = ["@name exported", "@description exported from ahap web editor", "@events"];
  for (const item of editor.items) {
    if (item.kind === "transient") {
      lines.push(`transient t=${item.time} intensity=${item.intensity} sharpness=${item.sharpness}`);
    } else if (item.kind === "continuous") {
      let line = `continuous t=${item.time} duration=${item.duration} intensity=${item.intensity} sharpness=${item.sharpness}`;
      if (item.attack !== null && item.attack !== undefined) line += ` attack=${item.attack}`;
      if (item.decay !== null && item.decay !== undefined) line += ` decay=${item.decay}`;
      if (item.release !== null && item.release !== undefined) line += ` release=${item.release}`;
      lines.push(line);
    } else if (item.kind === "curve") {
      const last = item.points[item.points.length - 1];
      const first = item.points[0];
      const param = item.parameterId === "HapticIntensityControl" ? "intensity" : "sharpness";
      lines.push(
        `curve ${param} t=${item.time} duration=${last ? last.time : 0} from=${first ? first.value : 0} to=${last ? last.value : 0} steps=${item.points.length}`
      );
    } else if (item.kind === "curveRegion") {
      const span = item.endTime - item.time;
      if (item.sharpnessPoints.length) {
        const first = item.sharpnessPoints[0];
        const last = item.sharpnessPoints[item.sharpnessPoints.length - 1];
        lines.push(`curve sharpness t=${item.time} duration=${span} from=${first.value} to=${last.value} steps=${item.sharpnessPoints.length}`);
      }
      if (item.intensityPoints.length) {
        const first = item.intensityPoints[0];
        const last = item.intensityPoints[item.intensityPoints.length - 1];
        lines.push(`curve intensity t=${item.time} duration=${span} from=${first.value} to=${last.value} steps=${item.intensityPoints.length}`);
      }
    }
  }
  downloadText("pattern.msh", lines.join("\n") + "\n", "text/plain");
  editor.announce("exported pattern.msh");
});

function wireFileImport(buttonId, inputId, handler) {
  const btn = byId(buttonId);
  const input = byId(inputId);
  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    try {
      await handler(file);
    } catch (err) {
      editor.alert(`import failed: ${err.message}`);
      console.error(err);
    }
  });
}

wireFileImport("btnOpenAhap", "fileAhap", async (file) => {
  const text = await file.text();
  const obj = JSON.parse(text);
  const items = ahapToItems(obj);
  const meta = metaFromAhap(obj);
  editor.loadItems(items, { announceMsg: `opened ${file.name}, ${items.length} items` });
  if (meta.tempo) dom.fTempo.value = meta.tempo;
  if (meta.timeSignature && /^\d+\/\d+$/.test(meta.timeSignature)) {
    const [num, den] = meta.timeSignature.split("/").map(Number);
    editor.timeSig = { num, den };
    editor.timeMode = "bars";
    editor._recomputeTimeStep();
    editor.render();
  }
});

wireFileImport("btnImportMsh", "fileMsh", async (file) => {
  const text = await file.text();
  const { items, warnings } = parseMsh(text);
  editor.loadItems(items, {
    trackName: file.name,
    announceMsg: `imported ${file.name}, ${items.length} items${warnings.length ? ", " + warnings.length + " warnings" : ""}`,
  });
  if (warnings.length) console.warn(warnings.join("\n"));
});

wireFileImport("btnImportMidi", "fileMidi", async (file) => {
  const buf = await file.arrayBuffer();
  const midi = parseMidi(buf);
  const { items, warnings } = midiToItems(midi, {});
  editor.loadItems(items, {
    trackName: file.name,
    announceMsg: `imported ${file.name}, ${items.length} items${warnings.length ? ", " + warnings.length + " warnings" : ""}`,
  });
  if (warnings.length) console.warn(warnings.join("\n"));
});

// ---- Project save/open (lossless intermediate representation) -------------
//
// Unlike .ahap (which merges tracks and only informally carries tempo/time
// signature via extra Metadata keys), this format is the editor's own -
// it keeps tracks, curve regions, and the bar/beat grid exactly as authored.

byId("btnSaveProject").addEventListener("click", () => {
  const project = {
    formatVersion: 1,
    items: editor.items,
    tracks: editor.tracks,
    activeTrackId: editor.activeTrackId,
    timeMode: editor.timeMode,
    timeSig: editor.timeSig,
    zoomLevel: editor.zoomLevel,
    tempo: parseFloat(dom.fTempo.value) || 120,
  };
  downloadText("pattern.hstudio.json", JSON.stringify(project, null, 2));
  editor.announce("saved pattern.hstudio.json");
});

wireFileImport("btnOpenProject", "fileProject", async (file) => {
  const text = await file.text();
  const project = JSON.parse(text);
  editor.tracks = project.tracks && project.tracks.length ? project.tracks : editor.tracks;
  editor.activeTrackId = project.activeTrackId || editor.tracks[0].id;
  editor.timeMode = project.timeMode || "raw";
  editor.timeSig = project.timeSig || { num: 4, den: 4 };
  editor.zoomLevel = project.zoomLevel || 3;
  if (project.tempo) dom.fTempo.value = project.tempo;
  editor.renderTracks();
  editor.loadItems(project.items || [], { announceMsg: `opened project ${file.name}, ${(project.items || []).length} items` });
  editor._recomputeTimeStep();
  editor.render();
});

// ---- Experimental WebSocket sender -----------------------------------------

let ws = null;
byId("btnWsConnect").addEventListener("click", () => {
  const url = byId("wsUrl").value.trim();
  if (!url) {
    editor.alert("enter a WebSocket URL first");
    return;
  }
  try {
    ws = new WebSocket(url);
    byId("wsStatus").textContent = "Connecting...";
    ws.onopen = () => {
      byId("wsStatus").textContent = "Connected";
      editor.announce("WebSocket connected");
    };
    ws.onclose = () => {
      byId("wsStatus").textContent = "Disconnected";
    };
    ws.onerror = () => {
      byId("wsStatus").textContent = "Error";
      editor.alert("WebSocket connection error");
    };
  } catch (err) {
    editor.alert(`WebSocket error: ${err.message}`);
  }
});

byId("btnWsSend").addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    editor.alert("not connected");
    return;
  }
  const events = editor.items.filter((it) => it.kind !== "curve" && it.kind !== "curveRegion" && it.time >= editor.cursorTime - 1e-9);
  const startedAt = performance.now();
  for (const item of events) {
    const delayMs = (item.time - editor.cursorTime) * 1000;
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(item));
    }, Math.max(0, delayMs));
  }
  void startedAt;
  editor.announce(`sending ${events.length} events over WebSocket`);
});
