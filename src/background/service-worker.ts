/**
 * Service worker: orchestrates a reading session. It extracts page text via an
 * injected content function, splits it into chunk-sized pieces, opens a port to
 * the offscreen playback document, and walks the chunks in order — each chunk
 * is fetched and played by the offscreen document. Session state is mirrored
 * into storage.session so the popup always renders the current phase.
 */
import {
  IDLE_STATE,
  type AppState,
  type ExtractResult,
  type HighlightMessage,
  type PlaybackCommand,
  type PlaybackEvent,
  type PopupMessage,
  type ReadMode,
  type StateResponse,
} from "../shared/messages";
import { MAX_CHUNK_CHARS } from "../shared/config";
import { planChunks, type SentenceSpan } from "./chunking";
import { extractInPage, probeSelectionInPage } from "../content/page-reader";

const PORT_NAME = "playback";
const OFFSCREEN_PATH = "offscreen/offscreen.html";
const READ_SELECTION_MENU_ID = "phonon-read-selection";

let sessionGeneration = 0;
let pauseRequested = false;
let playbackPort: chrome.runtime.Port | null = null;
let pendingPlayback: ((event: PlaybackEvent) => void) | null = null;

/** Highlighting state for the active session. */
let highlightTabId: number | undefined;
let sentenceSpans: SentenceSpan[] = [];
let chunkSentenceRanges: { first: number; last: number }[] = [];
let lastHighlightedKey = "";

/* ------------------------------------------------------------------ */
/* Popup message handling                                              */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(
  (message: PopupMessage, _sender, sendResponse) => {
    void handlePopupMessage(message).then(sendResponse);
    return true; // keep the channel open for the async response
  },
);

// Keep-alive pings from the offscreen document renew the idle timer.
chrome.runtime.onMessage.addListener(() => {
  return false;
});

// Right-click context menu: read the selected text aloud.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: READ_SELECTION_MENU_ID,
    title: "Read selection aloud (Phonon)",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === READ_SELECTION_MENU_ID && tab?.id) {
    void startReading("selection", tab.id);
  }
});

async function handlePopupMessage(
  message: PopupMessage,
): Promise<StateResponse> {
  try {
    switch (message.type) {
      case "READ": {
        void startReading(message.mode);
        break;
      }
      case "PAUSE": {
        await pauseSession();
        break;
      }
      case "RESUME": {
        await resumeSession();
        break;
      }
      case "STOP": {
        await endSession(null);
        break;
      }
      case "GET_STATE": {
        break;
      }
    }
  } catch (error) {
    await setState({ phase: "idle", error: describeError(error) });
  }
  return snapshot(message.probeSelection);
}

async function snapshot(probe: boolean): Promise<StateResponse> {
  const app = await readState();
  const hasSelection = probe ? await probeSelection() : false;
  return { app, hasSelection };
}

async function readState(): Promise<AppState> {
  const stored = await chrome.storage.session.get("app");
  return (stored["app"] as AppState | undefined) ?? IDLE_STATE;
}

async function setState(patch: Partial<AppState>): Promise<void> {
  const stored = await chrome.storage.session.get("app");
  const app = {
    ...IDLE_STATE,
    ...(stored["app"] as AppState | undefined),
    ...patch,
  };
  await chrome.storage.session.set({ app });
}

/* ------------------------------------------------------------------ */
/* Session state transitions                                           */
/* ------------------------------------------------------------------ */

async function startReading(mode: ReadMode, tabId?: number): Promise<void> {
  const generation = ++sessionGeneration;
  pauseRequested = false;

  await setState({
    phase: "extracting",
    error: null,
    pageTitle: "",
    chunkIndex: 0,
    chunkCount: 0,
  });
  await ensureOffscreenDocument();
  closePlaybackPort();

  const extracted = await extractText(mode, tabId);
  if (generation !== sessionGeneration) {
    return;
  }
  if (!extracted.ok) {
    await setState({
      phase: "idle",
      error: describeExtractFailure(extracted.reason),
    });
    return;
  }

  // Show the on-page control widget in the tab being read.
  const readTabId = extracted.tabId;
  if (readTabId !== undefined) {
    void injectOverlay(readTabId);
  }

  const plan = planChunks(extracted.text, MAX_CHUNK_CHARS);
  if (plan.chunks.length === 0) {
    await setState({
      phase: "idle",
      error: "No readable text found on this page.",
    });
    return;
  }

  // Remember highlighting context for the session.
  highlightTabId = readTabId;
  sentenceSpans = plan.sentences;
  chunkSentenceRanges = plan.chunkSentenceRanges;
  lastHighlightedKey = "";

  await setState({
    phase: "loading",
    pageTitle: extracted.title,
    chunkCount: plan.chunks.length,
    chunkIndex: 0,
  });
  void playChunks(generation, extracted.title, plan.chunks);
}

async function playChunks(
  generation: number,
  _title: string,
  chunks: string[],
): Promise<void> {
  const isCurrent = () => generation === sessionGeneration;

  for (let index = 0; index < chunks.length; index += 1) {
    if (!isCurrent()) {
      return;
    }
    await waitWhilePaused(generation);
    if (!isCurrent()) {
      return;
    }

    await setState({ phase: "loading", chunkIndex: index });
    const delivered = await deliverChunk(index, chunks[index], isCurrent);
    if (!isCurrent()) {
      return;
    }
    if (!delivered) {
      await setState({
        phase: "idle",
        error: "Could not reach the playback surface.",
      });
      return;
    }

    await setState({ phase: "playing", chunkIndex: index });
    const event = await waitForChunkEvent(index);
    if (!isCurrent()) {
      return;
    }
    if (event.type === "CHUNK_ERROR") {
      await setState({
        phase: "idle",
        error: event.error ?? "Playback failed.",
      });
      return;
    }
  }

  await endSession(null);
}

/** Waits until RESUME clears the pause flag (or the session ends). */
async function waitWhilePaused(generation: number): Promise<void> {
  while (pauseRequested && generation === sessionGeneration) {
    await sleep(120);
  }
}

/**
 * Sends one chunk to the offscreen document. Retries a few times if the
 * offscreen document was closed (e.g. Chrome may drop it after long pauses).
 */
async function deliverChunk(
  id: number,
  text: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  const command: PlaybackCommand = { type: "PLAY_CHUNK", id, text };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!isCurrent()) {
      return false;
    }
    if (!playbackPort) {
      await ensureOffscreenDocument();
      openPlaybackPort();
    }
    const port = playbackPort;
    if (!port) {
      return false;
    }
    try {
      port.postMessage(command);
      return true;
    } catch {
      closePlaybackPort(); // stale port; reconnect and try again
    }
  }
  return false;
}

function waitForChunkEvent(id: number): Promise<PlaybackEvent> {
  return new Promise((resolve) => {
    pendingPlayback = (event) => {
      if (event.id === id) {
        pendingPlayback = null;
        resolve(event);
      }
    };
  });
}

async function pauseSession(): Promise<void> {
  const phase = (await readState()).phase;
  if (phase !== "playing" && phase !== "loading") {
    return;
  }
  pauseRequested = true;
  sendCommand({ type: "PAUSE" });
  await setState({ phase: "paused" });
}

async function resumeSession(): Promise<void> {
  if (!pauseRequested) {
    return;
  }
  pauseRequested = false;
  sendCommand({ type: "RESUME" });
  await setState({ phase: "playing" });
}

/** Ends the active session and returns the UI to idle (with an error, if any). */
async function endSession(error: string | null): Promise<void> {
  sessionGeneration += 1;
  pauseRequested = false;
  pendingPlayback = null;
  sendCommand({ type: "STOP" });
  closePlaybackPort();
  await clearHighlight();
  await removeOverlay();
  highlightTabId = undefined;
  sentenceSpans = [];
  chunkSentenceRanges = [];
  lastHighlightedKey = "";
  await setState({ phase: "idle", chunkIndex: 0, error });
}

/* ------------------------------------------------------------------ */
/* Sentence highlighting                                               */
/* ------------------------------------------------------------------ */

/**
 * Maps a chunk-relative playback position to the sentence currently being
 * spoken and tells the page to highlight it.
 */
async function updateHighlight(
  chunkId: number,
  charIndex: number,
): Promise<void> {
  const range = chunkSentenceRanges[chunkId];
  if (!range || highlightTabId === undefined) {
    return;
  }
  // The offscreen document reports a position within the chunk text; convert
  // it to an offset within the chunk, then to an absolute text offset by
  // locating the chunk's first sentence start.
  const firstSentence = sentenceSpans[range.first];
  if (!firstSentence) {
    return;
  }
  const chunkStart = firstSentence.start;
  const absolute = chunkStart + charIndex;

  let sentenceIndex = range.first;
  for (let i = range.first; i < range.last; i += 1) {
    if (absolute >= sentenceSpans[i].start) {
      sentenceIndex = i;
    } else {
      break;
    }
  }
  const span = sentenceSpans[sentenceIndex];
  const key = `${span.start}:${span.end}`;
  if (key === lastHighlightedKey) {
    return;
  }
  lastHighlightedKey = key;
  await sendHighlight({ type: "HIGHLIGHT", start: span.start, end: span.end });
}

async function sendHighlight(message: HighlightMessage): Promise<void> {
  if (highlightTabId === undefined) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(highlightTabId, message);
  } catch {
    // Overlay not injected or tab navigated away; highlighting is best-effort.
  }
}

async function clearHighlight(): Promise<void> {
  await sendHighlight({ type: "HIGHLIGHT_CLEAR" });
}

/* ------------------------------------------------------------------ */
/* Playback port                                                       */
/* ------------------------------------------------------------------ */

function openPlaybackPort(): void {
  if (playbackPort) {
    return;
  }
  const port = chrome.runtime.connect({ name: PORT_NAME });
  playbackPort = port;
  port.onMessage.addListener((event: PlaybackEvent) => {
    if (event.type === "CHUNK_PROGRESS") {
      void updateHighlight(event.id, event.charIndex);
      return;
    }
    if (event.type === "CHUNK_ENDED" || event.type === "CHUNK_ERROR") {
      pendingPlayback?.(event);
    }
  });
  port.onDisconnect.addListener(() => {
    if (playbackPort === port) {
      playbackPort = null;
    }
  });
}

function closePlaybackPort(): void {
  if (playbackPort) {
    try {
      playbackPort.disconnect();
    } catch {
      // Already disconnected.
    }
    playbackPort = null;
  }
}

function sendCommand(command: PlaybackCommand): void {
  try {
    playbackPort?.postMessage(command);
  } catch {
    // Port closing; deliverChunk reconnects when it needs one again.
  }
}

/* ------------------------------------------------------------------ */
/* Offscreen document lifecycle                                        */
/* ------------------------------------------------------------------ */

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: "Plays WAV audio streamed from the local phonon TTS model.",
  });
  // Give the document a moment to load its listeners.
  await sleep(150);
}

/* ------------------------------------------------------------------ */
/* Text extraction                                                     */
/* ------------------------------------------------------------------ */

async function extractText(
  mode: ReadMode,
  tabId?: number,
): Promise<ExtractResult & { tabId?: number }> {
  const tab =
    tabId !== undefined
      ? await chrome.tabs.get(tabId)
      : await findReadableTab();
  if (!tab?.id) {
    return { ok: false, reason: "restricted" };
  }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractInPage,
      args: [mode],
    });
    const extracted = result?.result as ExtractResult | undefined;
    if (!extracted) {
      return { ok: false, reason: "failed" };
    }
    return extracted.ok ? { ...extracted, tabId: tab.id } : extracted;
  } catch {
    return { ok: false, reason: "restricted" };
  }
}

async function probeSelection(): Promise<boolean> {
  const tab = await findReadableTab();
  if (!tab?.id) {
    return false;
  }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: probeSelectionInPage,
    });
    return result?.result === true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* On-page overlay widget                                              */
/* ------------------------------------------------------------------ */

/** Injects the playback widget into the tab being read (idempotent). */
async function injectOverlay(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/overlay.js"],
    });
  } catch {
    // Page may have navigated; the widget is a nicety, not critical.
  }
}

/** Tells any injected widget in the read tab to remove itself. */
async function removeOverlay(): Promise<void> {
  const tab = await findReadableTab();
  if (!tab?.id) {
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        document.getElementById("phonon-reader-overlay")?.remove();
        document.getElementById("phonon-reader-overlay-style")?.remove();
      },
    });
  } catch {
    // Tab may be gone; nothing to clean up.
  }
}

/**
 * Finds the tab to read from: the active web page in the last focused normal
 * window. Extension pages (popup opened as a tab), chrome:// pages, and PDFs
 * are skipped so the reader never tries to read itself. When the active tab is
 * not injectable (e.g. the popup is open as a tab), fall back to the most
 * recently used injectable tab in that window.
 */
async function findReadableTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const injectable = tabs.filter((tab) => isInjectable(tab.url));
  return injectable.find((tab) => tab.active) ?? injectable[0];
}

function isInjectable(url: string | undefined): boolean {
  return url !== undefined && /^https?:/.test(url);
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

function describeExtractFailure(
  reason: "noselection" | "empty" | "restricted" | "failed",
): string {
  switch (reason) {
    case "noselection":
      return "No text is selected on this page.";
    case "empty":
      return "No readable text found on this page.";
    case "restricted":
      return "This page cannot be read (browser or system page).";
    default:
      return "Could not extract text from this page.";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
