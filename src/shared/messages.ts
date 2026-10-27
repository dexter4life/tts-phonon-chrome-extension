/**
 * Message contracts shared by every extension context (popup, service worker,
 * offscreen document). Keeping them in one place makes the
 * popup ↔ worker ↔ offscreen protocol explicit and type-checked.
 */

/** Which part of the page the user asked to hear. */
export type ReadMode = "page" | "selection";

/** Popup → service worker requests. */
export type PopupMessage =
  | { type: "READ"; mode: ReadMode; probeSelection: boolean }
  | { type: "PAUSE"; probeSelection: boolean }
  | { type: "RESUME"; probeSelection: boolean }
  | { type: "STOP"; probeSelection: boolean }
  | { type: "GET_STATE"; probeSelection: boolean };

export type ExtractResult =
  | { ok: true; text: string; title: string }
  | { ok: false; reason: "noselection" | "empty" | "restricted" | "failed" };

/** Service worker → offscreen document commands, sent over the playback port. */
export type PlaybackCommand =
  | { type: "PLAY_CHUNK"; id: number; text: string }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "STOP" };

/** Offscreen document → service worker playback events, sent over the port. */
export type PlaybackEvent =
  | {
      type: "CHUNK_ENDED" | "CHUNK_ERROR";
      id: number;
      error?: string;
    }
  | {
      type: "CHUNK_PROGRESS";
      id: number;
      /** Characters of the chunk's text spoken so far (approximate). */
      charIndex: number;
    };

/** Phases of a reading session as shown in the popup. */
export type SessionPhase =
  | "idle"
  | "extracting"
  | "loading"
  | "playing"
  | "paused";

/** Snapshot of the reading session, persisted in chrome.storage.session. */
export interface AppState {
  phase: SessionPhase;
  chunkIndex: number;
  chunkCount: number;
  pageTitle: string;
  error: string | null;
}

export const IDLE_STATE: AppState = {
  phase: "idle",
  chunkIndex: 0,
  chunkCount: 0,
  pageTitle: "",
  error: null,
};

/** Response payload for every popup message. */
export interface StateResponse {
  app: AppState;
  hasSelection: boolean;
}

/**
 * Service worker → content script (overlay): which sentence to highlight.
 * `start`/`end` are character offsets into the extracted page text.
 */
export type HighlightMessage =
  | { type: "HIGHLIGHT"; start: number; end: number }
  | { type: "HIGHLIGHT_CLEAR" };
