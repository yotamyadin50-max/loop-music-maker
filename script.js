"use strict";

/* ===================== Shared: sound engine ===================== */

const LS_LOOPS_KEY = "paama-loops-v1";
const LS_ONBOARD_KEY = "paama-onboarding-done";
const GRID_SIZE = 32;

/* each pad's idle shade climbs from dull purple to bright turquoise across the grid, in pitch
   order, per direct request ("כל לחצן גוון שלו לפי הסדר מהסגול הכי קהה לתכלת הכי בהיר"). Reuses
   the same two brand colors already anchoring the rest of the palette, just interpolated per
   pad instead of applied flat. */
function pitchGradientColor(index, total) {
  const pct = Math.round((index / (total - 1)) * 100);
  return "color-mix(in oklab, var(--color-piano) " + pct + "%, var(--color-drums))";
}

let audioCtx = null;
let noiseBuffer = null;

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    noiseBuffer = buildNoiseBuffer(audioCtx);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function buildNoiseBuffer(ctx) {
  const len = ctx.sampleRate * 1;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/* 32 piano tiles: C major scale (8 degrees incl. octave top) across octaves, low to high */
function buildPianoScale() {
  const degrees = [0, 2, 4, 5, 7, 9, 11, 12]; // semitone offsets within an octave, incl. octave repeat
  const notes = [];
  let octave = 0;
  while (notes.length < GRID_SIZE) {
    for (const d of degrees) {
      if (notes.length >= GRID_SIZE) break;
      const midi = 48 + octave * 12 + d; // 48 = C3
      notes.push(midiToFreq(midi));
    }
    octave++;
  }
  return notes;
}
function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
const PIANO_FREQS = buildPianoScale();

/* Every play* function returns the source node(s) it created, so a caller can
   track and, if needed, stop them early (a real mute/restart has to silence
   already-scheduled-but-not-yet-played notes, not just stop scheduling new ones). */
function playPiano(tileIndex, time, gainMult) {
  const ctx = ensureAudio();
  const freq = PIANO_FREQS[tileIndex];
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(freq, time);
  const gain = ctx.createGain();
  const peak = 0.35 * (gainMult == null ? 1 : gainMult);
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(peak, time + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.9);
  osc.connect(gain).connect(ctx.destination);
  osc.start(time);
  osc.stop(time + 0.95);
  return [osc];
}

/* 32 drum tiles: low (kick/tom, pitched) to high (snare/hihat, noise), synthesized */
function playDrum(tileIndex, time, gainMult) {
  const ctx = ensureAudio();
  const t = tileIndex / (GRID_SIZE - 1); // 0..1 low to high
  const mult = gainMult == null ? 1 : gainMult;
  const gainOut = ctx.createGain();
  gainOut.connect(ctx.destination);

  if (t < 0.5) {
    /* pitched, kick/tom family */
    const startFreq = 180 - t * 2 * 100; // higher tiles in this half = higher toms
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(startFreq * 2.2, time);
    osc.frequency.exponentialRampToValueAtTime(startFreq * 0.6, time + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9 * mult, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.28);
    osc.connect(g).connect(gainOut);
    osc.start(time);
    osc.stop(time + 0.3);
    return [osc];
  } else {
    /* noise-based, snare/hihat family */
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    const t2 = (t - 0.5) * 2; // 0..1 within this half
    filter.frequency.setValueAtTime(900 + t2 * 6000, time);
    const g = ctx.createGain();
    const decay = 0.22 - t2 * 0.16; // brighter tiles decay faster (hihat-like)
    g.gain.setValueAtTime(0.5 * mult, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + Math.max(decay, 0.04));
    src.connect(filter).connect(g).connect(gainOut);
    src.start(time);
    src.stop(time + 0.3);
    return [src];
  }
}

function triggerSound(instrument, tileIndex, time, gainMult) {
  return instrument === "piano" ? playPiano(tileIndex, time, gainMult) : playDrum(tileIndex, time, gainMult);
}

/* Per-layer active-node tracking, so a real mute/delete/restart can silence
   notes already handed to the audio clock, not just stop scheduling more. */
function createNodeTracker() {
  const byKey = new Map();
  return {
    track(key, nodes) {
      if (!byKey.has(key)) byKey.set(key, []);
      const arr = byKey.get(key);
      nodes.forEach((n) => {
        arr.push(n);
        n.addEventListener("ended", () => {
          const idx = arr.indexOf(n);
          if (idx !== -1) arr.splice(idx, 1);
        });
      });
    },
    stop(key) {
      const ctx = ensureAudio();
      const arr = byKey.get(key) || [];
      arr.forEach((n) => {
        try {
          n.stop(ctx.currentTime);
        } catch (e) {
          /* already stopped/ended, ignore */
        }
      });
      byKey.set(key, []);
    },
    stopAll() {
      for (const key of byKey.keys()) this.stop(key);
    },
  };
}

/* ===================== Shared: encode / decode loop state ===================== */

function encodeLoop(loop) {
  const json = JSON.stringify(loop);
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function decodeLoop(str) {
  try {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(b64)));
    return migrateLoopLayers(JSON.parse(json));
  } catch (e) {
    return null;
  }
}

/* every layer used to share one global length/joinIteration; each layer now carries its own
   independent length + an absolute joinAt (seconds from loopStartTime), so a later sound can
   run longer or shorter than the first one, per direct request. Old saved/shared data only has
   the shared loopLength and an integer joinIteration, so backfill the new fields from those. */
function migrateLoopLayers(loopData) {
  if (!loopData || !Array.isArray(loopData.layers)) return loopData;
  const masterLength = loopData.loopLength;
  loopData.layers.forEach((layer) => {
    if (layer.length == null) layer.length = masterLength;
    if (layer.joinAt == null) layer.joinAt = (layer.joinIteration || 0) * masterLength;
    if (layer.activeFrom == null) layer.activeFrom = 0;
    if (layer.activeTo == null) layer.activeTo = layer.length;
  });
  return loopData;
}

/* a hand-edited, truncated, or otherwise corrupted ?share= link can decode to syntactically
   valid JSON that's still nonsense (missing loopLength, an empty layers array, a layer missing
   its own notes, an out-of-range tileIndex). Loading that unchecked doesn't just fail loudly:
   NaN/undefined periods silently stop a scheduler tick forever with no error, and a bad
   tileIndex throws inside a setInterval that then re-throws every tick. Reject it up front with
   one visible message instead of a silently-broken or permanently-crashing loop. */
function isValidLoopData(loopData) {
  if (!loopData || !Array.isArray(loopData.layers) || loopData.layers.length === 0) return false;
  if (typeof loopData.loopLength !== "number" || !(loopData.loopLength > 0)) return false;
  return loopData.layers.every(
    (l) =>
      l &&
      typeof l.instrument === "string" &&
      Array.isArray(l.notes) &&
      l.notes.every((n) => Number.isInteger(n.tileIndex) && n.tileIndex >= 0 && n.tileIndex < GRID_SIZE && typeof n.time === "number")
  );
}

function loadAllLoops() {
  try {
    const list = JSON.parse(localStorage.getItem(LS_LOOPS_KEY) || "[]");
    list.forEach((entry) => migrateLoopLayers(entry.loop));
    return list;
  } catch (e) {
    return [];
  }
}
function saveAllLoops(list) {
  localStorage.setItem(LS_LOOPS_KEY, JSON.stringify(list));
}

function confirmDialog(message, confirmLabel) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML =
      '<div class="confirm-box" role="alertdialog" aria-modal="true">' +
      "<p>" + message + "</p>" +
      '<div class="confirm-box__actions">' +
      '<button type="button" class="btn btn--error" data-yes>' + (confirmLabel || "כן, למחוק") + "</button>" +
      '<button type="button" class="btn btn--outline" data-no>לא, להישאר</button>' +
      "</div></div>";
    document.body.appendChild(overlay);
    overlay.querySelector("[data-yes]").focus();
    function close(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.querySelector("[data-yes]").addEventListener("click", () => close(true));
    overlay.querySelector("[data-no]").addEventListener("click", () => close(false));
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close(false);
    });
  });
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/* ===================== Home page ===================== */

function initHome() {
  const grid = document.querySelector(".demo-pads");
  if (!grid) return;
  const cells = [];
  for (let i = 0; i < 32; i++) {
    const c = document.createElement("div");
    c.className = "demo-pads__cell";
    grid.appendChild(c);
    cells.push(c);
  }
  const pattern = [4, 12, 20, 4, 28, 12, 4, 20];
  let step = 0;
  setInterval(() => {
    const idx = pattern[step % pattern.length];
    cells[idx].classList.remove("demo-pads__cell--lit");
    void cells[idx].offsetWidth;
    cells[idx].classList.add("demo-pads__cell--lit");
    step++;
  }, 420);
}

/* ===================== Studio page ===================== */

function initStudio() {
  const root = document.querySelector("[data-studio]");
  if (!root) return;

  const grid = root.querySelector(".pad-grid");
  const startBtn = root.querySelector("[data-action='start']");
  const enterLoopBtn = root.querySelector("[data-action='enter-loop']");
  const layerCountEl = root.querySelector("[data-layer-count]");
  const currentRoundWrapEl = root.querySelector("[data-current-round-wrap]");
  const currentRoundEl = root.querySelector("[data-current-round]");
  const instrumentBtns = root.querySelectorAll("[data-instrument]");
  const layersPanel = root.querySelector("[data-layers-panel]");
  const layersHintEl = root.querySelector("[data-layers-hint]");
  const saveBtn = root.querySelector("[data-action='save']");
  const restartBtn = root.querySelector("[data-action='restart']");
  const lockRing = root.querySelector(".lock-ring");
  const banner = root.querySelector("[data-banner]");
  const onboarding = root.querySelector("[data-onboarding]");
  const playheadFill = root.querySelector(".playhead-track__fill");
  const armedStatus = root.querySelector("[data-armed-status]");
  const loopTrimEl = root.querySelector("[data-loop-trim]");
  const loopLengthDisplayEl = root.querySelector("[data-loop-length-display]");
  const trimShorterBtn = root.querySelector("[data-action='trim-shorter']");
  const trimLongerBtn = root.querySelector("[data-action='trim-longer']");
  const trimTrackEl = root.querySelector("[data-loop-trim-track]");
  const trimFillEl = root.querySelector("[data-loop-trim-fill]");
  const trimHandleEl = root.querySelector("[data-loop-trim-handle]");
  const LOOP_TRIM_STEP = 0.1;
  let trimMax = 4; /* the draggable track's own scale in seconds, recomputed whenever a loop is (re)established */
  const previewPanelEl = root.querySelector("[data-preview-panel]");
  const previewPlayBtn = root.querySelector("[data-action='preview-play']");
  const previewRestartBtn = root.querySelector("[data-action='preview-restart']");
  const previewHintEl = root.querySelector("[data-preview-hint]");

  let currentInstrument = "drums";
  let armed = false;
  let armedAt = 0;
  let loopStartTime = null;
  let loopLength = null;
  let schedulerTimer = null;
  let playheadTimer = null;
  let layers = []; // { instrument, notes:[{tileIndex,time}], muted, gain, length, joinAt, activeFrom, activeTo }
  let pendingTaps = []; // for the layer currently being recorded
  let editingLoopId = null;
  const nodeTracker = createNodeTracker(); // keyed by layer object, so mute/delete/restart can silence what's already scheduled

  /* preview mode: a second, separate playback engine (own tracker, own timer, own elapsed clock)
     so it can pause/resume/restart without touching the live-recording clock or state, per
     direct request for the same build-up preview + pause/resume/restart already in "הלופים שלי"
     to also work live, inside the Studio, while still editing. A look-ahead scheduler, same
     shape as the live one below, since each layer can now have its own independent length. */
  let previewMode = false;
  let previewPlaying = false;
  let previewTimer = null;
  let previewAnchor = 0; // ctx time representing elapsed=0 on the preview timeline
  let previewResumeElapsed = 0;
  const previewTracker = createNodeTracker();

  /* build 32 pads */
  const pads = [];
  for (let i = 0; i < GRID_SIZE; i++) {
    const pad = document.createElement("button");
    pad.type = "button";
    pad.className = "pad";
    pad.setAttribute("aria-label", "פד " + (i + 1));
    pad.dataset.index = String(i);
    pad.style.setProperty("--pad-gradient-color", pitchGradientColor(i, GRID_SIZE));
    grid.appendChild(pad);
    pads.push(pad);
  }

  function setInstrument(name) {
    currentInstrument = name;
    instrumentBtns.forEach((b) => b.classList.toggle("instrument-picker__btn--active", b.dataset.instrument === name));
    const label = name === "piano" ? "פסנתר" : "תופים";
    pads.forEach((pad, i) => pad.setAttribute("aria-label", "פד " + (i + 1) + ", " + label));
  }
  instrumentBtns.forEach((b) => b.addEventListener("click", () => setInstrument(b.dataset.instrument)));
  setInstrument("drums");

  /* a layer is exactly one instrument (matches the layer panel's own model), so once a note
     is pending for the layer being recorded, lock the picker, don't let a mid-recording switch
     silently mislabel already-tapped notes under the wrong instrument at commit time. */
  function updateInstrumentLock() {
    const locked = pendingTaps.length > 0;
    instrumentBtns.forEach((b) => {
      b.disabled = locked && b.dataset.instrument !== currentInstrument;
    });
  }

  function lightPad(index, instrument) {
    const pad = pads[index];
    const cls = instrument === "piano" ? "pad--piano-lit" : "pad--drums-lit";
    pad.classList.add(cls);
    setTimeout(() => pad.classList.remove(cls), 140);
  }

  function padTap(index) {
    const ctx = ensureAudio();
    dismissOnboarding("grid");
    const now = ctx.currentTime;
    /* always play, even before "התחל": free exploration of the pads is not
       gated behind recording. "התחל"/an existing loop only controls whether
       this tap ALSO gets recorded, never whether it makes sound at all. */
    triggerSound(currentInstrument, index, now);
    lightPad(index, currentInstrument);

    if (!armed) return; /* not recording: the tap already played above, and stops here. Without
      this guard, once a loop existed, every idle tap (just trying sounds, not "התחל"-armed) fell
      into the loop-relative branch below and sat in pendingTaps, so a later "enterLoop" press
      could bake in taps the player never meant to record. Found from a real report: "I want to
      still be able to play sounds without starting a loop." */

    /* record raw elapsed time since THIS recording's own "התחל" press, same for the first
       layer or any later one: no longer force-wrapped into an existing loop's length, so a
       later sound's own pattern can run longer (or shorter) than the first one, per direct
       request. The wrap used to fold long taps back on themselves mid-recording, scrambling
       the pattern the player actually meant to make. */
    pendingTaps.push({ tileIndex: index, absTime: now });
    enterLoopBtn.disabled = pendingTaps.length === 0;
    updateInstrumentLock();
  }
  pads.forEach((pad) => pad.addEventListener("pointerdown", () => padTap(Number(pad.dataset.index))));

  startBtn.addEventListener("click", () => {
    exitPreview(); /* "התחל" always means "back to editing", per direct instruction */
    const ctx = ensureAudio();
    armed = true;
    armedAt = ctx.currentTime;
    pendingTaps = [];
    enterLoopBtn.disabled = true;
    root.querySelector(".transport").classList.add("transport--armed");
    if (armedStatus) armedStatus.hidden = false;
    updateInstrumentLock();
    dismissOnboarding("start");
  });

  enterLoopBtn.addEventListener("click", () => {
    if (pendingTaps.length === 0) return;
    exitPreview(); /* committing a layer while preview was left running: the new layer never got
      a _previewNextCycleStart (preview only initializes it at start/resume) and, for a later
      layer, the live scheduler was stopped by preview and nothing here restarted it — the new
      layer would sit silent in both engines until an unrelated preview pause/resume happened to
      fix it. Same rule "התחל" already follows: any live edit drops back to normal editing. */
    const ctx = ensureAudio();

    /* closing gap = opening gap, per the approved rule: every layer gets its OWN length this
       way, not just the first one, so a later sound can run longer or shorter than the first,
       per direct request ("I want to be able to make the second sound longer than the first
       sound's loop"). Floor at 0.3s: a real human can't close a loop faster than that, and a
       near-zero length would make its scheduler re-enter itself absurdly fast. */
    const first = pendingTaps[0];
    const last = pendingTaps[pendingTaps.length - 1];
    const gap0 = first.absTime - armedAt;
    const layerLength = Math.max(0.3, last.absTime - armedAt + gap0);
    const notes = pendingTaps.map((t) => ({ tileIndex: t.tileIndex, time: t.absTime - armedAt }));

    if (loopStartTime === null) {
      /* the first layer also defines the master grid: the clock everyone else's join timing,
         the playhead, and the round indicator are measured against. */
      loopStartTime = armedAt;
      loopLength = layerLength;
      const layer = {
        instrument: currentInstrument,
        notes,
        muted: false,
        gain: 1,
        length: layerLength,
        joinAt: 0,
        activeFrom: 0,
        activeTo: layerLength,
      };
      layer._nextCycleStart = loopStartTime + loopLength; /* cycle 0 already played live while tapping */
      layers.push(layer);
      startScheduler();
      updateLoopTrimDisplay();
      previewPanelEl.hidden = false;
    } else {
      /* an added layer joins at the next full round of the MASTER grid: the round in progress
         finishes as-is, the new layer starts at the next clean boundary. Chosen over an
         unpredictable "whenever the scheduler happens to catch up" join, per direct request to
         pick a consistent rule rather than leave it implicit. From there on it repeats at ITS
         OWN length, independent of the master grid or any other layer's length. */
      const elapsed = ctx.currentTime - loopStartTime;
      const joinAt = (Math.floor(elapsed / loopLength) + 1) * loopLength;
      const layer = {
        instrument: currentInstrument,
        notes,
        muted: false,
        gain: 1,
        length: layerLength,
        joinAt,
        activeFrom: 0,
        activeTo: layerLength,
      };
      layer._nextCycleStart = loopStartTime + joinAt;
      layers.push(layer);
    }
    pendingTaps = [];
    enterLoopBtn.disabled = true;
    armed = false;
    root.querySelector(".transport").classList.remove("transport--armed");
    if (armedStatus) armedStatus.hidden = true;
    updateInstrumentLock();
    lockPulse();
    renderLayers();
    dismissOnboarding("enter-loop", true);
  });

  function lockPulse() {
    lockRing.style.opacity = "1";
    lockRing.classList.remove("lock-ring--pulsing");
    void lockRing.offsetWidth;
    setTimeout(() => lockRing.classList.add("lock-ring--pulsing"), 400);
  }

  function latestNoteEnd() {
    /* the real floor for trimming the MASTER grid (the global loop-length control): never cut
       it shorter than the first layer's own last note, per direct request to edit the length
       "like trimming the clip", not silently drop content. Other layers now keep their own
       independent length, unaffected by this control, so only layer 0 counts here. */
    if (layers.length === 0) return 0;
    let latest = 0;
    for (const note of layers[0].notes) latest = Math.max(latest, note.time);
    return latest;
  }

  /* every layer's REAL playing time is activeTo-activeFrom, not its original recorded length:
     cutting from the start or the end shortens how often the layer itself repeats, exactly like
     trimming a clip, per direct request ("when I cut from the end or the start it should reduce
     the total time of that sound's own loop"). layer.length stays fixed as the outer ceiling
     (the raw recording), never mutated, so trimming is always reversible back out to it. */
  function effectivePeriod(layer) {
    const to = layer.activeTo == null ? (layer.length || loopLength) : layer.activeTo;
    return Math.max(0.05, to - (layer.activeFrom || 0));
  }

  /* layer 0 defines the master grid: keep loopLength (used for the playhead, round indicator,
     and every other layer's join quantization) equal to layer 0's own current effective period,
     whichever of the two trim UIs (the global panel or layer 0's own per-layer controls) just
     changed it. */
  function syncMasterGrid() {
    if (!layers[0]) return;
    loopLength = effectivePeriod(layers[0]);
    updateLoopTrimDisplay();
  }

  function updateLoopTrimDisplay() {
    if (loopLength === null) {
      loopTrimEl.hidden = true;
      return;
    }
    loopTrimEl.hidden = false;
    loopLengthDisplayEl.textContent = loopLength.toFixed(1) + " שנ'";
    /* keep the drag track's own scale stable and always wide enough to reach the current
       length, so a big loop is never stuck squeezed against the handle's max position. */
    if (loopLength > trimMax * 0.9) trimMax = Math.max(loopLength * 1.6, latestNoteEnd() + 3);
    const pct = Math.max(0, Math.min(100, (loopLength / trimMax) * 100));
    trimFillEl.style.width = pct + "%";
    trimHandleEl.style.insetInlineStart = pct + "%";
    trimHandleEl.setAttribute("aria-valuenow", loopLength.toFixed(1));
    trimHandleEl.setAttribute("aria-valuemax", trimMax.toFixed(1));
  }

  function trackPositionToLength(clientX) {
    const rect = trimTrackEl.getBoundingClientRect();
    if (!rect.width) return null; /* not actually laid out yet, don't compute a bogus value */
    /* the track reads right-to-left in this RTL layout: the start (0s) edge is the visual right */
    const fromRight = rect.right - clientX;
    const frac = Math.max(0, Math.min(1, fromRight / rect.width));
    return frac * trimMax;
  }

  let trimDragging = false;
  trimHandleEl.addEventListener("pointerdown", (e) => {
    if (loopLength === null) return;
    trimDragging = true;
    trimHandleEl.setPointerCapture(e.pointerId);
  });
  trimHandleEl.addEventListener("pointermove", (e) => {
    if (!trimDragging) return;
    const preview = trackPositionToLength(e.clientX);
    if (preview === null) return;
    const pct = Math.max(0, Math.min(100, (preview / trimMax) * 100));
    trimFillEl.style.width = pct + "%";
    trimHandleEl.style.insetInlineStart = pct + "%";
    loopLengthDisplayEl.textContent = Math.max(latestNoteEnd() + 0.05, preview).toFixed(1) + " שנ'";
  });
  function finishTrimDrag(e) {
    if (!trimDragging) return;
    trimDragging = false;
    const value = trackPositionToLength(e.clientX);
    if (value === null) {
      updateLoopTrimDisplay(); /* snap back to the real value instead of leaving a stale preview */
      return;
    }
    applyLoopLength(value);
  }
  trimHandleEl.addEventListener("pointerup", finishTrimDrag);
  trimHandleEl.addEventListener("pointercancel", () => {
    trimDragging = false;
    updateLoopTrimDisplay();
  });
  trimHandleEl.addEventListener("keydown", (e) => {
    if (loopLength === null) return;
    /* this track reads right-to-left (see trackPositionToLength above): dragging the handle
       left makes the loop LONGER, dragging right makes it SHORTER. Arrow keys must match that
       same visual direction, not the opposite — found via review: they were inverted from what
       dragging the same handle does. */
    if (e.key === "ArrowLeft") applyLoopLength(loopLength + LOOP_TRIM_STEP);
    else if (e.key === "ArrowRight") applyLoopLength(loopLength - LOOP_TRIM_STEP);
  });
  /* clicking anywhere on the track jumps the handle straight there, a real "cut here" gesture */
  trimTrackEl.addEventListener("pointerdown", (e) => {
    if (loopLength === null || e.target === trimHandleEl) return;
    const value = trackPositionToLength(e.clientX);
    if (value !== null) applyLoopLength(value);
  });

  function reanchorLive() {
    /* re-anchor the clock without discarding each layer's real joinAt (still the source of
       truth for the build-up order once saved), so everyone already-present plays together
       immediately while actively editing, regardless of their own length or when they'd
       normally join. loopStartTime resets to "now" too (not just layer 0's own next cycle),
       which keeps the playhead/round-indicator honest about what's actually audible, since
       layer 0 (the master grid) also restarts its cycle right here. */
    if (loopStartTime === null) return;
    if (previewMode) {
      /* any live edit (trim, join round, loop length) drops back to normal editing, same rule
         as "התחל": preview and the live editing engine must never both be scheduling at once,
         or notes double up. */
      previewMode = false;
      stopPreviewPlayback();
    }
    stopScheduler();
    nodeTracker.stopAll();
    const now = ensureAudio().currentTime + 0.05;
    loopStartTime = now;
    layers.forEach((layer) => { layer._nextCycleStart = now; });
    startScheduler();
  }

  function applyLoopLength(newLength) {
    if (newLength === null || Number.isNaN(newLength) || !layers[0]) return;
    const from = layers[0].activeFrom || 0;
    const floor = Math.max(0.3, latestNoteEnd() - from + 0.05);
    const target = Math.max(floor, Math.round(newLength * 10) / 10);
    /* this control shrinks/extends the SAME way as layer 0's own end-trim button: it cuts from
       the end, keeping whatever start-cut is already in place, and can never extend past the
       original recording (layer.length, the fixed ceiling). */
    layers[0].activeTo = Math.min(layers[0].length, from + target);
    syncMasterGrid();
    reanchorLive();
    renderLayers(); /* layer 0's own trim/length readout depends on loopLength too, keep it in sync */
  }
  trimShorterBtn.addEventListener("click", () => {
    if (loopLength === null) return;
    applyLoopLength(loopLength - LOOP_TRIM_STEP);
  });
  trimLongerBtn.addEventListener("click", () => {
    if (loopLength === null) return;
    applyLoopLength(loopLength + LOOP_TRIM_STEP);
  });

  function stopPreviewPlayback() {
    previewPlaying = false;
    if (previewTimer) clearInterval(previewTimer);
    previewTimer = null;
    previewTracker.stopAll();
    previewPlayBtn.textContent = "▶";
    previewPlayBtn.setAttribute("aria-label", "נגן מההתחלה");
  }

  /* look-ahead scheduler, same shape as the live one below: each layer can have its own
     independent length now, so a single shared "iteration" number no longer describes
     playback position. fromElapsed is seconds into the preview timeline (0 = the very start,
     or wherever a previous pause left off), used to resume in place. */
  function startPreviewPlayback(fromElapsed) {
    const ctx = ensureAudio();
    previewPlaying = true;
    previewPlayBtn.textContent = "⏸";
    previewPlayBtn.setAttribute("aria-label", "השהה תצוגה מקדימה");
    previewAnchor = ctx.currentTime + 0.05 - fromElapsed;
    layers.forEach((layer) => {
      const period = effectivePeriod(layer);
      const joinAt = layer.joinAt || 0;
      const startElapsed = Math.max(joinAt, fromElapsed);
      const n = Math.ceil((startElapsed - joinAt) / period);
      layer._previewNextCycleStart = previewAnchor + joinAt + n * period;
    });
    if (previewTimer) clearInterval(previewTimer);
    previewTimer = setInterval(previewTick, 25);
  }

  function previewTick() {
    const ctx = ensureAudio();
    const scheduleAhead = 0.15;
    previewResumeElapsed = ctx.currentTime - previewAnchor;
    for (const layer of layers) {
      if (layer.muted) continue;
      const period = effectivePeriod(layer);
      const from = layer.activeFrom || 0;
      const to = from + period;
      /* defensive: a layer with no _previewNextCycleStart (e.g. pushed while preview was
         somehow already running) would otherwise compare undefined < number, always false,
         and stay silently unscheduled forever with no self-heal, unlike the live scheduler
         below which already guards this. */
      if (layer._previewNextCycleStart === undefined) layer._previewNextCycleStart = ctx.currentTime;
      while (layer._previewNextCycleStart < ctx.currentTime + scheduleAhead) {
        const cycleStart = layer._previewNextCycleStart;
        for (const note of layer.notes) {
          if (note.time < from || note.time > to) continue; /* rebased so the trimmed-in part starts at cycle position 0 */
          const when = cycleStart + (note.time - from);
          const nodes = triggerSound(layer.instrument, note.tileIndex, when, layer.gain);
          previewTracker.track(layer, nodes);
          const delayMs = Math.max(0, (when - ctx.currentTime) * 1000);
          setTimeout(() => lightPad(note.tileIndex, layer.instrument), delayMs);
        }
        layer._previewNextCycleStart += period;
      }
    }
  }

  function enterPreview() {
    if (loopLength === null) return;
    previewMode = true;
    stopScheduler(); /* pause live editing playback so the two engines never overlap */
    nodeTracker.stopAll();
    previewHintEl.hidden = false;
    previewResumeElapsed = 0;
    startPreviewPlayback(0);
  }
  function exitPreview() {
    if (!previewMode) return;
    previewMode = false;
    stopPreviewPlayback();
    previewHintEl.hidden = true; /* enterPreview shows it; every exit path must hide it back, not just the preview buttons' own */
    /* back to normal live editing: everyone already recorded plays together again immediately */
    reanchorLive();
  }

  previewPlayBtn.addEventListener("click", () => {
    if (!previewMode) {
      enterPreview();
      return;
    }
    if (previewPlaying) stopPreviewPlayback();
    else startPreviewPlayback(previewResumeElapsed);
  });
  previewRestartBtn.addEventListener("click", () => {
    if (!previewMode) enterPreview();
    else {
      stopPreviewPlayback();
      startPreviewPlayback(0);
    }
  });

  function startScheduler() {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(schedulerTick, 25);
    startPlayhead();
  }
  function stopScheduler() {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
    stopPlayhead();
  }

  /* setInterval, not requestAnimationFrame: rAF can silently stop firing when the tab/pane
     is backgrounded (document.hidden), a known limitation already logged in this system. */
  function startPlayhead() {
    if (playheadTimer) return;
    playheadTimer = setInterval(() => {
      if (loopStartTime === null) return;
      const ctx = ensureAudio();
      const elapsed = ctx.currentTime - loopStartTime;
      const progress = (elapsed % loopLength) / loopLength;
      playheadFill.style.width = Math.max(0, Math.min(1, progress)) * 100 + "%";
      /* rounds of the MASTER grid (layer 0's own length), surfaced so "מצטרף בסיבוב" on a
         layer card means something concrete while editing. */
      currentRoundWrapEl.hidden = false;
      currentRoundEl.textContent = String(Math.max(0, Math.floor(elapsed / loopLength)));
    }, 50);
  }
  function stopPlayhead() {
    if (playheadTimer) clearInterval(playheadTimer);
    playheadTimer = null;
    playheadFill.style.width = "0%";
    currentRoundWrapEl.hidden = true;
  }
  /* each layer now repeats at its own independent length, so scheduling tracks each layer's
     own next-cycle time instead of one shared iteration count across the whole loop. */
  function schedulerTick() {
    if (loopStartTime === null) return;
    const ctx = ensureAudio();
    const scheduleAhead = 0.15;
    for (const layer of layers) {
      if (layer.muted) continue;
      if (layer._nextCycleStart === undefined) layer._nextCycleStart = loopStartTime + (layer.joinAt || 0);
      const period = effectivePeriod(layer);
      const from = layer.activeFrom || 0;
      const to = from + period;
      while (layer._nextCycleStart < ctx.currentTime + scheduleAhead) {
        const cycleStart = layer._nextCycleStart;
        for (const note of layer.notes) {
          if (note.time < from || note.time > to) continue; /* trimmed off this layer's own start/end */
          const when = cycleStart + (note.time - from); /* rebased so the trimmed-in part starts at cycle position 0 */
          const nodes = triggerSound(layer.instrument, note.tileIndex, when, layer.gain);
          nodeTracker.track(layer, nodes);
          const delayMs = Math.max(0, (when - ctx.currentTime) * 1000);
          setTimeout(() => lightPad(note.tileIndex, layer.instrument), delayMs);
        }
        layer._nextCycleStart += period;
      }
    }
  }

  function renderLayers() {
    layerCountEl.textContent = String(layers.length);
    /* a friend opening a shared link lands straight in this panel with zero context for what
       the per-layer trim/join controls do, so a short standing hint once real content exists. */
    if (layersHintEl) layersHintEl.hidden = layers.length === 0;
    layersPanel.innerHTML = "";
    if (layers.length === 0) {
      const empty = document.createElement("p");
      empty.className = "layers-panel__empty";
      empty.textContent = "עדיין אין שכבות. תתחיל לנגן.";
      layersPanel.appendChild(empty);
      return;
    }
    const perInstrumentCount = { drums: 0, piano: 0 };
    layers.forEach((layer, i) => {
      perInstrumentCount[layer.instrument]++;
      const card = document.createElement("div");
      card.className = "layer-card" + (layer.muted ? " layer-card--muted" : "");
      const dot = document.createElement("span");
      dot.className = "layer-card__dot layer-card__dot--" + layer.instrument;
      const name = document.createElement("span");
      name.className = "layer-card__name";
      name.textContent = (layer.instrument === "piano" ? "פסנתר" : "תופים") + " " + perInstrumentCount[layer.instrument];

      const volume = document.createElement("input");
      volume.type = "range";
      volume.className = "layer-card__volume";
      volume.min = "0";
      volume.max = "100";
      volume.value = String(Math.round((layer.gain == null ? 1 : layer.gain) * 100));
      volume.setAttribute("aria-label", "עוצמה, " + name.textContent);
      volume.addEventListener("input", () => {
        layer.gain = Number(volume.value) / 100;
      });

      const muteBtn = document.createElement("button");
      muteBtn.type = "button";
      muteBtn.className = "btn layer-card__btn" + (layer.muted ? " layer-card__btn--muted" : "");
      muteBtn.setAttribute("aria-label", layer.muted ? "בטל השתקה" : "השתק שכבה");
      muteBtn.textContent = layer.muted ? "🔇" : "🔊";
      muteBtn.addEventListener("click", () => {
        layer.muted = !layer.muted;
        if (layer.muted) {
          nodeTracker.stop(layer); /* silence what's already scheduled, not just future notes */
          previewTracker.stop(layer);
        } else {
          /* while muted, neither scheduler advanced this layer's own next-cycle clock, so
             un-muting after a while would otherwise replay every missed cycle at once in a
             single tick (Web Audio clamps a `when` in the past to "now"): a burst instead of
             silence. Fast-forward each engine's pointer to the next real upcoming boundary. */
          const ctx = ensureAudio();
          const period = effectivePeriod(layer);
          if (layer._nextCycleStart !== undefined) {
            const elapsed = ctx.currentTime - layer._nextCycleStart;
            if (elapsed > 0) layer._nextCycleStart += Math.ceil(elapsed / period) * period;
          }
          if (layer._previewNextCycleStart !== undefined) {
            const elapsedP = ctx.currentTime - layer._previewNextCycleStart;
            if (elapsedP > 0) layer._previewNextCycleStart += Math.ceil(elapsedP / period) * period;
          }
        }
        renderLayers();
      });
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn layer-card__btn";
      delBtn.setAttribute("aria-label", "מחק שכבה");
      delBtn.textContent = "🗑";
      delBtn.addEventListener("click", () => {
        nodeTracker.stop(layer); /* real delete stops sound immediately, not just after the current pass finishes */
        previewTracker.stop(layer); /* same, for whichever engine (live or preview) happens to be running */
        layers.splice(i, 1);
        if (layers.length === 0) {
          /* nothing left to loop: the next recording must start a fresh master grid, not
             silently inherit the deleted loop's clock and quantize itself as if joining a loop
             that no longer exists. Found via testing: delete-the-only-layer then record a new
             one produced a nonzero joinAt against a stale loopStartTime. Same reset as "התחל
             מחדש", minus the confirm (deleting the last layer one at a time already was it). */
          stopPreviewPlayback();
          previewMode = false;
          previewPanelEl.hidden = true;
          previewHintEl.hidden = true;
          stopScheduler();
          loopStartTime = null;
          loopLength = null;
          editingLoopId = null;
          lockRing.classList.remove("lock-ring--pulsing");
          lockRing.style.opacity = "0";
          if (banner) banner.hidden = true;
          updateLoopTrimDisplay();
        } else {
          syncMasterGrid(); /* whichever layer is now layers[0] (possibly a different one, if index 0 was deleted) defines the master grid */
        }
        renderLayers();
      });
      const topRow = document.createElement("div");
      topRow.className = "layer-card__top";
      topRow.append(dot, name, volume, muteBtn, delBtn);

      /* per-layer trim: independent start/end cut for THIS sound's own loop window, within
         its OWN length (every layer now has one, independent of any other layer's), per
         direct request. Shown as "how much cut", matching the user's own words ("remove time
         from the start and from the end"). */
      const TRIM_STEP = 0.1;
      const trimRow = document.createElement("div");
      trimRow.className = "layer-card__trim";

      function layerPeriod() {
        return layer.length || loopLength;
      }
      function currentTo() {
        return layer.activeTo == null ? layerPeriod() : layer.activeTo;
      }
      const startValue = document.createElement("span");
      startValue.className = "layer-card__trim-value";
      const endValue = document.createElement("span");
      endValue.className = "layer-card__trim-value";
      const lengthValue = document.createElement("span");
      lengthValue.className = "layer-card__trim-value layer-card__trim-value--length";
      function refreshTrimValues() {
        startValue.textContent = (layer.activeFrom || 0).toFixed(1) + " שנ'";
        endValue.textContent = Math.max(0, layerPeriod() - currentTo()).toFixed(1) + " שנ'";
        lengthValue.textContent = Math.max(0, currentTo() - (layer.activeFrom || 0)).toFixed(1) + " שנ'";
      }
      refreshTrimValues();

      /* the resulting playing time of THIS layer's own loop, after both trims: a plain readout,
         no +/- of its own since it's fully derived from the start/end cuts above, per direct
         request to also show "the time of each loop" alongside the cutting controls. */
      const lengthGroup = document.createElement("div");
      lengthGroup.className = "layer-card__trim-group";
      const lengthLabel = document.createElement("span");
      lengthLabel.className = "layer-card__trim-label";
      lengthLabel.textContent = "אורך השכבה";
      lengthGroup.append(lengthLabel, lengthValue);
      trimRow.append(lengthGroup);

      const startGroup = document.createElement("div");
      startGroup.className = "layer-card__trim-group";
      const startLabel = document.createElement("span");
      startLabel.className = "layer-card__trim-label";
      startLabel.textContent = "חיתוך מההתחלה";
      const startMinus = document.createElement("button");
      startMinus.type = "button";
      startMinus.className = "btn btn--outline btn--icon layer-card__trim-btn";
      startMinus.textContent = "−";
      startMinus.setAttribute("aria-label", "פחות חיתוך מההתחלה, " + name.textContent);
      const startPlus = document.createElement("button");
      startPlus.type = "button";
      startPlus.className = "btn btn--outline btn--icon layer-card__trim-btn";
      startPlus.textContent = "+";
      startPlus.setAttribute("aria-label", "עוד חיתוך מההתחלה, " + name.textContent);
      startMinus.addEventListener("click", () => {
        layer.activeFrom = Math.max(0, Math.round(((layer.activeFrom || 0) - TRIM_STEP) * 10) / 10);
        refreshTrimValues();
        syncMasterGrid();
        reanchorLive();
        if (i === 0) renderLayers(); /* trimming the master grid changes loopLength, which every other layer's own displayed "מצטרף בסיבוב" round number depends on */
      });
      startPlus.addEventListener("click", () => {
        const maxFrom = Math.max(0, currentTo() - TRIM_STEP);
        layer.activeFrom = Math.min(maxFrom, Math.round(((layer.activeFrom || 0) + TRIM_STEP) * 10) / 10);
        refreshTrimValues();
        syncMasterGrid();
        reanchorLive();
        if (i === 0) renderLayers();
      });
      startGroup.append(startLabel, startMinus, startValue, startPlus);

      const endGroup = document.createElement("div");
      endGroup.className = "layer-card__trim-group";
      const endLabel = document.createElement("span");
      endLabel.className = "layer-card__trim-label";
      endLabel.textContent = "חיתוך מהסוף";
      const endMinus = document.createElement("button");
      endMinus.type = "button";
      endMinus.className = "btn btn--outline btn--icon layer-card__trim-btn";
      endMinus.textContent = "−";
      endMinus.setAttribute("aria-label", "פחות חיתוך מהסוף, " + name.textContent);
      const endPlus = document.createElement("button");
      endPlus.type = "button";
      endPlus.className = "btn btn--outline btn--icon layer-card__trim-btn";
      endPlus.textContent = "+";
      endPlus.setAttribute("aria-label", "עוד חיתוך מהסוף, " + name.textContent);
      endMinus.addEventListener("click", () => {
        const next = Math.min(layerPeriod(), Math.round((currentTo() + TRIM_STEP) * 10) / 10);
        layer.activeTo = next;
        refreshTrimValues();
        syncMasterGrid();
        reanchorLive();
        if (i === 0) renderLayers();
      });
      endPlus.addEventListener("click", () => {
        const minTo = Math.min(layerPeriod(), (layer.activeFrom || 0) + TRIM_STEP);
        layer.activeTo = Math.max(minTo, Math.round((currentTo() - TRIM_STEP) * 10) / 10);
        refreshTrimValues();
        syncMasterGrid();
        reanchorLive();
        if (i === 0) renderLayers();
      });
      endGroup.append(endLabel, endMinus, endValue, endPlus);
      trimRow.append(startGroup, endGroup);

      /* per-layer join round: which repeat of the MASTER grid this layer starts being heard
         on, editable after the fact instead of only being fixed at the moment it was recorded,
         per direct request. Stored as joinAt (seconds from loopStartTime) so it can outlive a
         layer's own independent length, but shown/edited as whole master-grid rounds, same
         UX as before. Layer 0 IS the master grid's own origin (created with joinAt: 0, and
         every other layer's join-quantization and the playhead/round-indicator assume it stays
         0) — not exposed here, since editing it doesn't delay layer 0's live playback (which
         ignores joinAt while editing) but silently corrupts the build-up order once the loop is
         saved and replayed for real. Found via review, not a live-editing bug on its own. */
      if (i > 0) {
        const joinGroup = document.createElement("div");
        joinGroup.className = "layer-card__trim-group";
        const joinLabel = document.createElement("span");
        joinLabel.className = "layer-card__trim-label";
        joinLabel.textContent = "מצטרף בסיבוב";
        const joinMinus = document.createElement("button");
        joinMinus.type = "button";
        joinMinus.className = "btn btn--outline btn--icon layer-card__trim-btn";
        joinMinus.textContent = "−";
        joinMinus.setAttribute("aria-label", "הצטרף מוקדם יותר, " + name.textContent);
        const joinValue = document.createElement("span");
        joinValue.className = "layer-card__trim-value";
        const joinPlus = document.createElement("button");
        joinPlus.type = "button";
        joinPlus.className = "btn btn--outline btn--icon layer-card__trim-btn";
        joinPlus.textContent = "+";
        joinPlus.setAttribute("aria-label", "הצטרף מאוחר יותר, " + name.textContent);
        function refreshJoinValue() {
          joinValue.textContent = String(Math.round((layer.joinAt || 0) / loopLength));
        }
        refreshJoinValue();
        joinMinus.addEventListener("click", () => {
          layer.joinAt = Math.max(0, Math.round(((layer.joinAt || 0) - loopLength) * 100) / 100);
          refreshJoinValue();
          reanchorLive();
        });
        joinPlus.addEventListener("click", () => {
          layer.joinAt = Math.min(32 * loopLength, (layer.joinAt || 0) + loopLength);
          refreshJoinValue();
          reanchorLive();
        });
        joinGroup.append(joinLabel, joinMinus, joinValue, joinPlus);
        trimRow.append(joinGroup);
      }

      card.append(topRow, trimRow);
      layersPanel.appendChild(card);
    });
  }
  renderLayers();

  restartBtn.addEventListener("click", async () => {
    const ok = await confirmDialog("למחוק הכל ולהתחיל מאפס?");
    if (!ok) return;
    stopPreviewPlayback();
    previewMode = false;
    previewPanelEl.hidden = true;
    previewHintEl.hidden = true;
    stopScheduler();
    nodeTracker.stopAll(); /* real reset silences everything already scheduled, not just future notes */
    armed = false;
    loopStartTime = null;
    loopLength = null;
    layers = [];
    pendingTaps = [];
    editingLoopId = null;
    enterLoopBtn.disabled = true;
    root.querySelector(".transport").classList.remove("transport--armed");
    if (armedStatus) armedStatus.hidden = true;
    updateInstrumentLock();
    lockRing.classList.remove("lock-ring--pulsing");
    lockRing.style.opacity = "0";
    if (banner) banner.hidden = true;
    updateLoopTrimDisplay();
    renderLayers();
  });

  saveBtn.addEventListener("click", () => {
    if (layers.length === 0) return;
    /* strip transient runtime scheduling state (raw AudioContext timestamps, meaningless once
       reloaded) before persisting: the live engine's own pointer, and the preview engine's, in
       case the loop was ever previewed this session */
    const loopData = { loopLength, layers: layers.map(({ _nextCycleStart, _previewNextCycleStart, ...l }) => l) };
    const all = loadAllLoops();
    if (editingLoopId) {
      const idx = all.findIndex((l) => l.id === editingLoopId);
      if (idx !== -1) {
        all[idx].loop = loopData;
        all[idx].updatedAt = Date.now();
      }
    } else {
      const id = "loop-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
      all.unshift({ id, createdAt: Date.now(), loop: loopData });
      editingLoopId = id;
    }
    saveAllLoops(all);
    showToast("הלופ נשמר. אפשר למצוא אותו ב\"הלופים שלי\".");
  });

  function loadLoopIntoStudio(loopData) {
    if (!isValidLoopData(loopData)) {
      showToast("הקישור פגום, אי אפשר לטעון את הלופ הזה.");
      return false;
    }
    stopScheduler();
    nodeTracker.stopAll();
    /* keep each layer's real original joinAt (when it actually joined during recording), not
       reset to 0: that's the exact data "הלופים שלי" now replays as the build-up order, and
       editing/re-saving here must not silently erase it. The editor itself still hears everyone
       together immediately (reanchorLive below), only the SAVED data preserves the real join
       order and each layer's own independent length for later. */
    layers = loopData.layers.map((l) => ({ ...l, notes: l.notes.map((n) => ({ ...n })) }));
    syncMasterGrid(); /* derive loopLength from layer 0's own activeFrom/activeTo */
    loopStartTime = ensureAudio().currentTime; /* placeholder so reanchorLive's null-guard passes; it overwrites this */
    reanchorLive();
    renderLayers();
    updateLoopTrimDisplay();
    previewPanelEl.hidden = false;
    lockRing.style.opacity = "1";
    lockRing.classList.add("lock-ring--pulsing");
    return true;
  }

  function showToast(text) {
    let toast = document.querySelector(".toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast";
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add("toast--visible");
    setTimeout(() => toast.classList.remove("toast--visible"), 2600);
  }

  function dismissOnboarding(which, force) {
    if (!onboarding || onboarding.hidden) return;
    if (force || localStorage.getItem(LS_ONBOARD_KEY)) {
      onboarding.hidden = true;
      localStorage.setItem(LS_ONBOARD_KEY, "1");
    }
  }
  if (onboarding) {
    if (localStorage.getItem(LS_ONBOARD_KEY)) {
      onboarding.hidden = true;
    } else {
      const skip = onboarding.querySelector("[data-skip]");
      if (skip) skip.addEventListener("click", () => dismissOnboarding("skip", true));
    }
  }

  /* handle ?share= or ?edit= on load */
  const params = new URLSearchParams(location.search);
  if (params.has("share")) {
    const decoded = decodeLoop(params.get("share"));
    if (decoded && loadLoopIntoStudio(decoded) && banner) {
      banner.hidden = false;
      banner.textContent = "נטען לופ ששותף איתך. אפשר להמשיך לבנות עליו.";
    }
  } else if (params.has("edit")) {
    const id = params.get("edit");
    const all = loadAllLoops();
    const found = all.find((l) => l.id === id);
    if (found) {
      editingLoopId = id;
      loadLoopIntoStudio(found.loop);
    }
  }
}

/* ===================== Lessons page ===================== */

/* Five drums-only patterns, difficulty 1 (easiest) to 5 (hardest), each an 8-step measure.
   Kept to drums only per explicit instruction ("these are still beginners"): a pitched pattern
   adds a second thing to learn (which note) on top of rhythm itself, drums isolates rhythm alone.
   Tile choices: 2 = a deep kick, 18 = a mid-bright snare/clap, 29 = a bright, short hihat,
   picked from the existing low-to-high drum palette, not new sounds. Progression: a plain pulse,
   then the kick/snare backbeat every real beat is built on, then syncopation, then a second
   simultaneous voice (hihat) as continuous texture, then all three woven together. */
const DRUM_PATTERNS = [
  {
    name: "פעימה פשוטה",
    desc: "רק קיק, על כל פעימה. זו הבסיס של כל קצב.",
    hits: [[0, 2], [2, 2], [4, 2], [6, 2]],
  },
  {
    name: "קיק וסנר",
    desc: "קיק בהתחלה, סנר באמצע. זה בדיוק המבנה של רוב השירים שאתה מכיר.",
    hits: [[0, 2], [4, 2], [2, 18], [6, 18]],
  },
  {
    name: "קיק מסונקף",
    desc: "עוד שתי הקשות קיק, לא בדיוק על הפעימה. זה מה שנותן לקצב תחושת \"קפיצה\".",
    hits: [[0, 2], [3, 2], [4, 2], [7, 2], [2, 18], [6, 18]],
  },
  {
    name: "הוספת הייהאט",
    desc: "אותו קיק וסנר, אבל עכשיו הייהאט רץ על כל שמינייה. שתי ידיים ביחד.",
    hits: [
      [0, 2], [4, 2], [2, 18], [6, 18],
      [0, 29], [1, 29], [2, 29], [3, 29], [4, 29], [5, 29], [6, 29], [7, 29],
    ],
  },
  {
    name: "גרוב מלא",
    desc: "השיעור הכי קשה: שלושה כלים, בלי עוגן ברור על כל פעימה. תקשיב טוב לפני שתנסה.",
    hits: [
      [0, 2], [3, 2], [6, 2],
      [2, 18], [5, 18], [7, 18],
      [1, 29], [3, 29], [5, 29], [7, 29],
    ],
  },
];

/* Five piano phrases, each paired 1:1 with the DRUM_PATTERNS lesson of the same slot: the drum
   loop is the given foundation (already playing, per direct instruction "you create the drums
   there and then learn to add the piano on top of it"), and the lesson teaches the melodic
   phrase that sits on top of it. Tiles 8-15 = one octave (C4-C5) of the existing piano scale,
   a comfortable, singable middle range, not a new sound. Progression mirrors the drum side:
   landing exactly on the kick, a simple call-and-response, one syncopated note, a longer
   5-note phrase, then a fully off-the-beat line with no easy anchor. */
const PIANO_PHRASES = [
  {
    name: "מלודיה על הקיק",
    desc: "שלוש תווים עולים, בדיוק על אותם רגעים שהקיק כבר מכה. הכי קל להתחיל איתו.",
    hits: [[0, 8], [2, 10], [4, 12], [6, 15]],
  },
  {
    name: "שאלה ותשובה",
    desc: "תו יורד, אז תו עולה בחזרה. עונה לקיק ולסנר, לא רק חוזר עליהם.",
    hits: [[0, 12], [2, 10], [4, 8], [6, 10]],
  },
  {
    name: "תו אחד מחוץ לביט",
    desc: "כמעט אותו דבר, אבל תו אחד לא נופל בדיוק על שום דבר בתופים. זה מה שמלמד אותך לנגן עם הביט, לא רק לצידו.",
    hits: [[0, 8], [3, 12], [5, 10], [7, 8]],
  },
  {
    name: "מלודיה מלאה",
    desc: "חמישה תווים על פני כל התיבה, כמו הייהאט שממלא את הקצב בתופים.",
    hits: [[0, 8], [1, 9], [2, 10], [4, 12], [6, 11]],
  },
  {
    name: "מלודיה חופשית",
    desc: "השיעור הכי קשה: אף תו לא על פעימה ברורה. תקשיב הרבה פעמים לפני שתנסה.",
    hits: [[1, 10], [2, 12], [4, 15], [5, 13], [7, 12]],
  },
];

const LESSONS = [
  ...DRUM_PATTERNS.map((p) => ({ instrument: "drums", name: p.name, desc: p.desc, hits: p.hits, backing: null })),
  ...PIANO_PHRASES.map((p, i) => ({
    instrument: "piano",
    name: p.name,
    desc: p.desc,
    hits: p.hits,
    backing: DRUM_PATTERNS[i].hits,
  })),
];
const LESSON_STEP_SECONDS = 0.35;
const LS_LESSON_PROGRESS_KEY = "paama-lesson-progress-v1";
const MISS_MESSAGES = [
  "לא נורא, תתחיל שוב מהצעד הראשון.",
  "כמעט, תנסה שוב מההתחלה.",
  "זה בסדר גמור, קצב לוקח כמה ניסיונות.",
];
const SUCCESS_MESSAGES = [
  "מדויק! עוד פעם, ותתחיל לבנות זיכרון-שריר.",
  "בול! תעשה את זה שוב כדי שזה יידבק.",
  "ככה בדיוק. עוד חזרה אחת ואתה שולט בזה.",
];

function loadLessonProgress() {
  try {
    return JSON.parse(localStorage.getItem(LS_LESSON_PROGRESS_KEY) || "[]");
  } catch (e) {
    return [];
  }
}
function markLessonDone(index) {
  const done = loadLessonProgress();
  if (!done.includes(index)) {
    done.push(index);
    localStorage.setItem(LS_LESSON_PROGRESS_KEY, JSON.stringify(done));
  }
}

function initLessons() {
  const root = document.querySelector("[data-lessons]");
  if (!root) return;

  const picker = root.querySelector("[data-lesson-picker]");
  const titleEl = root.querySelector("[data-lesson-title]");
  const diffEl = root.querySelector("[data-lesson-difficulty]");
  const descEl = root.querySelector("[data-lesson-desc]");
  const gridEl = root.querySelector("[data-lesson-grid]");
  const demoBtn = root.querySelector("[data-action='demo']");
  const slowToggle = root.querySelector("[data-slow-toggle]");
  const beatCounterEl = root.querySelector("[data-beat-counter]");
  const statusEl = root.querySelector("[data-practice-status]");
  const repeatCountEl = root.querySelector("[data-repeat-count]");
  const rewardEl = root.querySelector("[data-reward]");
  const addToLoopBtn = root.querySelector("[data-action='add-to-loop']");
  const openStudioBtn = root.querySelector("[data-action='open-studio']");
  const prevBtn = root.querySelector("[data-action='prev']");
  const nextBtn = root.querySelector("[data-action='next']");

  let lessonIndex = 0;
  let pads = [];
  let expectedSequence = [];
  let userProgress = 0;
  let repeatCount = 0;
  const demoTracker = createNodeTracker();
  const pickerChips = [];

  /* lesson picker chips: two tracks of 5 (drums 1-5, then piano 6-10), each chip's dots show
     difficulty WITHIN its own track (piano lesson 1 shows 1 dot, same as drum lesson 1), a
     done-checkmark appears once that lesson has at least one successful practice repeat. */
  LESSONS.forEach((lesson, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lessons__picker-btn";
    const label = document.createElement("span");
    label.textContent = "שיעור " + (i + 1);
    const dots = document.createElement("span");
    dots.className = "lessons__picker-btn__dots";
    const diffInTrack = i % 5;
    for (let d = 0; d < 5; d++) {
      const dot = document.createElement("span");
      if (d <= diffInTrack) dot.classList.add("is-filled");
      dots.appendChild(dot);
    }
    const check = document.createElement("span");
    check.className = "lessons__picker-btn__check";
    check.textContent = "";
    btn.append(label, dots, check);
    btn.addEventListener("click", () => loadLesson(i));
    picker.appendChild(btn);
    pickerChips.push({ btn, check });
  });

  function refreshPickerProgress() {
    const done = loadLessonProgress();
    pickerChips.forEach((chip, i) => {
      chip.check.textContent = done.includes(i) ? "✓" : "";
    });
  }
  refreshPickerProgress();

  const backingTracker = createNodeTracker();
  let backingTimer = null;

  function buildGrid() {
    gridEl.innerHTML = "";
    pads = [];
    for (let i = 0; i < GRID_SIZE; i++) {
      const pad = document.createElement("button");
      pad.type = "button";
      pad.className = "pad";
      pad.style.setProperty("--pad-gradient-color", pitchGradientColor(i, GRID_SIZE));
      pad.addEventListener("pointerdown", () => onPracticeTap(i));
      gridEl.appendChild(pad);
      pads.push(pad);
    }
  }
  buildGrid();

  function stopBacking() {
    if (backingTimer) clearTimeout(backingTimer);
    backingTimer = null;
    backingTracker.stopAll();
  }

  /* the drum foundation for a piano lesson loops continuously and independently in the
     background while that lesson is open, per direct instruction: "you create the drums
     there, then learn to add the piano on top of it." Practice taps don't need to be
     phase-locked to it (the sequence check below only cares about tile ORDER, not exact
     timing), this is for real musical context, hearing the phrase over an actual beat. */
  function startBacking(backingHits) {
    stopBacking();
    const ctx = ensureAudio();
    let iteration = 0;
    const measureLen = 8 * LESSON_STEP_SECONDS;
    const startAt = ctx.currentTime + 0.05;
    function scheduleIteration() {
      const iterStart = startAt + iteration * measureLen;
      for (const [step, tile] of backingHits) {
        const nodes = triggerSound("drums", tile, iterStart + step * LESSON_STEP_SECONDS);
        backingTracker.track("backing", nodes);
      }
      iteration++;
      backingTimer = setTimeout(scheduleIteration, measureLen * 1000 - 30);
    }
    scheduleIteration();
  }

  function loadLesson(i) {
    lessonIndex = i;
    const lesson = LESSONS[i];
    const trackLabel = lesson.instrument === "piano" ? "פסנתר" : "תופים";
    titleEl.textContent = "שיעור " + (i + 1) + " מתוך " + LESSONS.length + " (" + trackLabel + "): " + lesson.name;
    descEl.textContent = lesson.desc;
    diffEl.innerHTML = "";
    const diffInTrack = (i % 5) + 1;
    for (let d = 1; d <= 5; d++) {
      const dot = document.createElement("span");
      if (d <= diffInTrack) dot.classList.add("is-filled");
      diffEl.appendChild(dot);
    }
    [...picker.children].forEach((btn, idx) => btn.classList.toggle("lessons__picker-btn--active", idx === i));

    pads.forEach((pad, idx) => pad.setAttribute("aria-label", "פד " + (idx + 1) + ", " + trackLabel));

    /* the sequence to match, sorted by step so "same order" means the same rhythmic order */
    expectedSequence = [...lesson.hits].sort((a, b) => a[0] - b[0]).map((h) => h[1]);
    userProgress = 0;
    repeatCount = 0;
    repeatCountEl.textContent = "0";
    rewardEl.hidden = true;
    openStudioBtn.hidden = true;
    statusEl.textContent = lesson.backing
      ? "התופים כבר מנגנים ברקע. עכשיו התור שלך: תוסיף את הפסנתר, באותו סדר."
      : "עכשיו התור שלך: תקיש על אותם פדים, באותו סדר.";
    pads.forEach((p) => p.classList.remove("pad--target"));
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === LESSONS.length - 1;

    if (lesson.backing) startBacking(lesson.backing);
    else stopBacking();
  }

  function playLesson() {
    const ctx = ensureAudio();
    demoTracker.stopAll();
    const lesson = LESSONS[lessonIndex];
    const stepSeconds = slowToggle.checked ? LESSON_STEP_SECONDS * 1.8 : LESSON_STEP_SECONDS;
    /* a synced, self-contained demo pass: pause the ambient backing loop for a clean listen,
       play backing (if any) plus the phrase together from a shared step 0, then resume the
       ambient loop once the pass ends, avoiding any phase-drift between the two. */
    if (lesson.backing) stopBacking();
    const startAt = ctx.currentTime + 0.05;
    const allHits = lesson.backing ? [...lesson.backing.map(([s, t]) => [s, t, "drums"]), ...lesson.hits.map(([s, t]) => [s, t, lesson.instrument])] : lesson.hits.map(([s, t]) => [s, t, lesson.instrument]);
    for (const [step, tile, instrument] of allHits) {
      const when = startAt + step * stepSeconds;
      const nodes = triggerSound(instrument, tile, when);
      demoTracker.track("demo", nodes);
      const delayMs = Math.max(0, (when - ctx.currentTime) * 1000);
      setTimeout(() => {
        const pad = pads[tile];
        const cls = instrument === "piano" ? "pad--piano-lit" : "pad--drums-lit";
        pad.classList.add(cls);
        setTimeout(() => pad.classList.remove(cls), 140);
      }, delayMs);
    }
    /* a plain beat count (1..8), not tied to whether that step has a hit, so the visitor
       can count along the same way a metronome click would, per the explicit "watch, then
       repeat" pedagogy this whole page is built around. */
    for (let step = 0; step < 8; step++) {
      const delayMs = Math.max(0, startAt + step * stepSeconds - ctx.currentTime) * 1000;
      setTimeout(() => {
        beatCounterEl.textContent = String(step + 1);
      }, delayMs);
    }
    const endDelayMs = (startAt + 8 * stepSeconds - ctx.currentTime) * 1000;
    setTimeout(() => {
      beatCounterEl.textContent = "";
      if (lesson.backing) startBacking(lesson.backing); /* resume the ambient loop for practice */
    }, endDelayMs);
  }
  demoBtn.addEventListener("click", playLesson);

  function onPracticeTap(tileIndex) {
    const ctx = ensureAudio();
    const lesson = LESSONS[lessonIndex];
    triggerSound(lesson.instrument, tileIndex, ctx.currentTime);
    const pad = pads[tileIndex];
    const litCls = lesson.instrument === "piano" ? "pad--piano-lit" : "pad--drums-lit";
    pad.classList.add(litCls);
    setTimeout(() => pad.classList.remove(litCls), 140);

    if (tileIndex === expectedSequence[userProgress]) {
      userProgress++;
      if (userProgress === expectedSequence.length) {
        repeatCount++;
        repeatCountEl.textContent = String(repeatCount);
        userProgress = 0;
        statusEl.textContent = SUCCESS_MESSAGES[Math.floor(Math.random() * SUCCESS_MESSAGES.length)];
        if (repeatCount >= 1) {
          rewardEl.hidden = false;
          markLessonDone(lessonIndex);
          refreshPickerProgress();
        }
      }
    } else {
      /* a miss just resets the attempt, never scolds, matches this build's own no-punish ethos */
      userProgress = tileIndex === expectedSequence[0] ? 1 : 0;
      statusEl.textContent = MISS_MESSAGES[Math.floor(Math.random() * MISS_MESSAGES.length)];
    }
  }

  addToLoopBtn.addEventListener("click", () => {
    const lesson = LESSONS[lessonIndex];
    const toLayer = (hits, instrument) => ({
      instrument,
      notes: hits.map(([step, tile]) => ({ tileIndex: tile, time: step * LESSON_STEP_SECONDS })),
      muted: false,
      gain: 1,
      joinIteration: 0,
    });
    const layers = lesson.backing
      ? [toLayer(lesson.backing, "drums"), toLayer(lesson.hits, "piano")]
      : [toLayer(lesson.hits, lesson.instrument)];
    const loopData = { loopLength: 8 * LESSON_STEP_SECONDS, layers };
    const encoded = encodeLoop(loopData);
    openStudioBtn.href = "studio.html?share=" + encoded;
    openStudioBtn.hidden = false;
    showListToast(
      lesson.backing
        ? "נוסף! שני הכלים ביחד. תלחץ \"פתח בסטודיו\" כדי להמשיך לבנות עליו."
        : "נוסף! תלחץ \"פתח בסטודיו\" כדי להמשיך לבנות עליו."
    );
  });

  prevBtn.addEventListener("click", () => {
    if (lessonIndex > 0) loadLesson(lessonIndex - 1);
  });
  nextBtn.addEventListener("click", () => {
    if (lessonIndex < LESSONS.length - 1) loadLesson(lessonIndex + 1);
  });

  loadLesson(0);
}

/* ===================== My Loops page ===================== */

function initMyLoops() {
  const list = document.querySelector("[data-loops-list]");
  if (!list) return;
  const all = loadAllLoops();

  if (all.length === 0) {
    const example = document.createElement("div");
    example.className = "loop-card loop-card--example";
    example.innerHTML =
      '<span class="loop-card__badge">דוגמה</span>' +
      '<span class="loop-card__date">היום</span>' +
      '<span>ככה כרטיס שמור נראה. תלחץ נגן כדי לשמוע.</span>' +
      '<div class="loop-card__actions"><button class="btn btn--outline btn--icon" data-example-play aria-label="נגן דוגמה">▶</button></div>';
    list.appendChild(example);

    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = "עדיין לא יצרת לופ.";
    list.appendChild(empty);

    const cta = document.createElement("a");
    cta.href = "studio.html";
    cta.className = "btn btn--accent";
    cta.style.display = "block";
    cta.style.width = "fit-content";
    cta.style.margin = "0 auto";
    cta.textContent = "צור את הראשון שלך";
    list.appendChild(cta);

    example.querySelector("[data-example-play]").addEventListener("click", () => {
      const ctx = ensureAudio();
      const now = ctx.currentTime;
      [0, 6, 12, 18].forEach((i, idx) => triggerSound("drums", i, now + idx * 0.3));
      [20, 24].forEach((i, idx) => triggerSound("piano", i, now + 0.3 + idx * 0.6));
    });
    return;
  }

  all.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "loop-card";
    const date = document.createElement("span");
    date.className = "loop-card__date";
    date.textContent = formatDate(entry.createdAt);

    const label = document.createElement("span");
    label.textContent = entry.loop.layers.length + " שכבות, " + entry.loop.loopLength.toFixed(1) + " שנ'";

    const actions = document.createElement("div");
    actions.className = "loop-card__actions";

    let playing = false;
    let playTimer = null;
    let playAnchor = 0; // ctx time representing elapsed=0 on this card's playback timeline
    let resumeElapsed = 0; /* where a future "play" press continues from, not always 0 */
    const playTracker = createNodeTracker();
    const playBtn = document.createElement("button");
    playBtn.className = "btn btn--outline btn--icon";
    playBtn.setAttribute("aria-label", "נגן לופ");
    playBtn.textContent = "▶";

    const restartBtn = document.createElement("button");
    restartBtn.className = "btn btn--outline btn--icon";
    restartBtn.setAttribute("aria-label", "מההתחלה");
    restartBtn.textContent = "⟲";

    function stopPlayback() {
      playing = false;
      if (playTimer) clearInterval(playTimer);
      playTimer = null;
      playTracker.stopAll(); /* stop silences what's already scheduled, not just future notes */
      playBtn.textContent = "▶";
    }

    /* look-ahead scheduler, same shape as Studio's: each layer has its own independent length,
       so a single shared "iteration" number can't describe playback position across all of
       them. fromElapsed lets "play" mean two different things on purpose: resuming (continue
       from resumeElapsed) or restarting (always 0), per direct request for both, not just one. */
    /* a layer's real playing time is activeTo-activeFrom, not its recorded length: cutting from
       the start or end shortens how often it repeats, same as Studio's own trim controls. */
    function effectivePeriod(layer, loopLength) {
      const to = layer.activeTo == null ? (layer.length || loopLength) : layer.activeTo;
      return Math.max(0.05, to - (layer.activeFrom || 0));
    }

    function startPlayback(fromElapsed) {
      const ctx = ensureAudio();
      playing = true;
      playBtn.textContent = "⏸";
      const { loopLength, layers } = entry.loop;
      playAnchor = ctx.currentTime + 0.05 - fromElapsed;
      layers.forEach((layer) => {
        const period = effectivePeriod(layer, loopLength);
        const joinAt = layer.joinAt || 0;
        const startElapsed = Math.max(joinAt, fromElapsed);
        const n = Math.ceil((startElapsed - joinAt) / period);
        layer._myNextCycleStart = playAnchor + joinAt + n * period;
      });
      if (playTimer) clearInterval(playTimer);
      playTimer = setInterval(() => {
        const c = ensureAudio();
        const scheduleAhead = 0.15;
        resumeElapsed = c.currentTime - playAnchor;
        for (const layer of layers) {
          if (layer.muted) continue;
          /* replays layers joining in the same real order/timing they were added during
             recording, per direct request, not all layers flat from the first note. */
          const period = effectivePeriod(layer, loopLength);
          const from = layer.activeFrom || 0;
          const to = from + period;
          if (layer._myNextCycleStart === undefined) layer._myNextCycleStart = c.currentTime; /* defensive, matches the live/preview engines' own guard */
          while (layer._myNextCycleStart < c.currentTime + scheduleAhead) {
            const cycleStart = layer._myNextCycleStart;
            for (const note of layer.notes) {
              if (note.time < from || note.time > to) continue;
              const nodes = triggerSound(layer.instrument, note.tileIndex, cycleStart + (note.time - from), layer.gain);
              playTracker.track(layer, nodes);
            }
            layer._myNextCycleStart += period;
          }
        }
      }, 25);
    }

    playBtn.addEventListener("click", () => {
      if (playing) {
        stopPlayback();
        return;
      }
      startPlayback(resumeElapsed);
    });
    restartBtn.addEventListener("click", () => {
      stopPlayback();
      resumeElapsed = 0;
      startPlayback(0);
    });

    function buildShareUrl() {
      const encoded = encodeLoop(entry.loop);
      return location.origin + location.pathname.replace(/my-loops\.html$/, "") + "studio.html?share=" + encoded;
    }

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn btn--outline";
    copyBtn.textContent = "העתק קישור";
    copyBtn.addEventListener("click", async () => {
      const url = buildShareUrl();
      try {
        await navigator.clipboard.writeText(url);
      } catch (e) {
        /* clipboard may be unavailable; fall back to prompt */
        window.prompt("העתק את הקישור:", url);
      }
      showListToast("הקישור הועתק. אפשר לשלוח לחבר.");
    });

    /* a real, standard wa.me share intent, not a fake "share" button, matches this system's own
       standing rule that WhatsApp deserves real, first-class placement in the Israeli market. */
    const whatsappBtn = document.createElement("a");
    whatsappBtn.className = "btn btn--outline btn--icon";
    whatsappBtn.setAttribute("aria-label", "שתף בוואטסאפ");
    whatsappBtn.target = "_blank";
    whatsappBtn.rel = "noopener";
    whatsappBtn.textContent = "💬";
    whatsappBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const text = encodeURIComponent("תשמע לופ שבניתי בפעימה: " + buildShareUrl());
      window.open("https://wa.me/?text=" + text, "_blank", "noopener");
    });

    const editBtn = document.createElement("a");
    editBtn.className = "btn btn--outline";
    editBtn.href = "studio.html?edit=" + encodeURIComponent(entry.id);
    editBtn.textContent = "פתח לעריכה";

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn--error btn--icon";
    delBtn.setAttribute("aria-label", "מחק לופ");
    delBtn.textContent = "🗑";
    delBtn.addEventListener("click", async () => {
      const ok = await confirmDialog("למחוק את הלופ הזה?");
      if (!ok) return;
      stopPlayback(); /* the card's own timer/tracker keep running otherwise: deleting a loop
        mid-playback would leave it audibly playing forever in the background, with no UI left
        to stop it short of reloading the page */
      const remaining = loadAllLoops().filter((l) => l.id !== entry.id);
      saveAllLoops(remaining);
      card.remove();
      if (remaining.length === 0) location.reload();
    });

    actions.append(playBtn, restartBtn, copyBtn, whatsappBtn, editBtn, delBtn);
    card.append(date, label, actions);
    list.appendChild(card);
  });
}

function showListToast(text) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("toast--visible");
  setTimeout(() => toast.classList.remove("toast--visible"), 2600);
}

/* ===================== Boot ===================== */

document.addEventListener(
  "pointerdown",
  () => {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  },
  { passive: true }
);

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "home") initHome();
  if (page === "studio") initStudio();
  if (page === "lessons") initLessons();
  if (page === "my-loops") initMyLoops();

  const path = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".site-header__link").forEach((link) => {
    const href = link.getAttribute("href");
    link.classList.toggle("site-header__link--active", href === path || (path === "" && href === "index.html"));
  });
});
