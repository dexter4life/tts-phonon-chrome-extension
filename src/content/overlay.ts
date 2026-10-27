/**
 * On-page playback widget. Injected by the service worker into the tab being
 * read; renders a fixed card in the page's top-right corner with the session
 * status and pause/resume/stop controls, so playback can be controlled without
 * keeping the toolbar popup open. Polls session state and removes itself when
 * the session goes idle. Also paints the currently-spoken sentence using the
 * CSS Custom Highlight API from the node map captured at extraction time.
 */
import type { AppState, HighlightMessage } from "../shared/messages";

const WIDGET_ID = "phonon-reader-overlay";
const STYLE_ID = "phonon-reader-overlay-style";
const HIGHLIGHT_STYLE_ID = "phonon-reader-highlight-style";
const POLL_MS = 500;

/** Node map stashed on window by extractInPage (same page context). */
interface NodeSpan {
  nodeIndex: number;
  start: number;
  end: number;
}

const NODE_MAP_KEY = "__phononNodeMap";

let capturedNodes: Node[] = [];
let capturedSpans: NodeSpan[] = [];
let highlight: Highlight | null = null;

function loadNodeMap(): void {
  const stashed = (window as unknown as Record<string, unknown>)[
    NODE_MAP_KEY
  ] as { nodes: Node[]; spans: NodeSpan[] } | undefined;
  if (stashed) {
    capturedNodes = stashed.nodes;
    capturedSpans = stashed.spans;
  }
}

function ensureHighlightStyles(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    ::highlight(phonon-current-sentence) {
      background-color: rgba(167, 139, 250, 0.35);
      border-radius: 2px;
    }
  `;
  document.head.appendChild(style);
  CSS.highlights.set("phonon-current-sentence", new Highlight());
}

function clearSentenceHighlight(): void {
  if (highlight !== null) {
    try {
      CSS.highlights.get("phonon-current-sentence")?.clear();
    } catch {
      // Registry entry already gone.
    }
    highlight = null;
  }
}

/** Paints the sentence covering [start, end) in the extracted text. */
function paintSentence(start: number, end: number): void {
  ensureHighlightStyles();
  const registry = CSS.highlights.get("phonon-current-sentence");
  if (!registry) {
    return;
  }
  const ranges: Range[] = [];
  for (const span of capturedSpans) {
    if (span.end <= start || span.end - span.start === 0) {
      continue;
    }
    if (span.start >= end) {
      break;
    }
    const node = capturedNodes[span.nodeIndex];
    if (!node || !node.isConnected) {
      continue;
    }
    // Intersect the node's span with the sentence span.
    const from = Math.max(span.start, start);
    const to = Math.min(span.end, end);
    if (to <= from) {
      continue;
    }
    const range = document.createRange();
    range.setStart(node, from - span.start);
    range.setEnd(node, to - span.start);
    ranges.push(range);
  }
  registry.clear();
  if (ranges.length > 0) {
    for (const range of ranges) {
      registry.add(range);
    }
    highlight = new Highlight(...ranges);
  }
}

const PHASE_LABEL: Record<AppState["phase"], string> = {
  idle: "Idle",
  extracting: "Reading page…",
  loading: "Generating…",
  playing: "Playing",
  paused: "Paused",
};

interface Widget {
  root: HTMLElement;
  status: HTMLElement;
  progress: HTMLElement;
  error: HTMLElement;
  toggle: HTMLButtonElement;
  stop: HTMLButtonElement;
}

let widget: Widget | null = null;
let pollTimer: number | undefined;
let lastPhase: AppState["phase"] = "idle";
let errorHoldUntil = 0;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${WIDGET_ID} {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      width: 220px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(20, 18, 28, 0.92);
      color: #f3eeff;
      font: 13px/1.4 system-ui, -apple-system, sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(6px);
    }
    #${WIDGET_ID} .ph-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 650;
      letter-spacing: 0.2px;
    }
    #${WIDGET_ID} .ph-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #9b93b3;
      flex: none;
    }
    #${WIDGET_ID} .ph-dot.active {
      background: #a78bfa;
      animation: ph-pulse 1.4s ease-in-out infinite;
    }
    #${WIDGET_ID} .ph-dot.paused {
      background: #eab308;
    }
    @keyframes ph-pulse {
      50% { opacity: 0.35; }
    }
    #${WIDGET_ID} .ph-status {
      margin: 6px 0 0;
      color: #9b93b3;
      font-size: 12px;
      min-height: 1.2em;
    }
    #${WIDGET_ID} .ph-progress {
      margin: 2px 0 0;
      color: #9b93b3;
      font-size: 11px;
      min-height: 1.2em;
    }
    #${WIDGET_ID} .ph-error {
      margin: 4px 0 0;
      color: #f87171;
      font-size: 11px;
      white-space: pre-wrap;
    }
    #${WIDGET_ID} .ph-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    #${WIDGET_ID} button {
      flex: 1;
      appearance: none;
      border: 1px solid #322c44;
      border-radius: 8px;
      background: #1e1a2b;
      color: #f3eeff;
      font: inherit;
      font-size: 12px;
      padding: 6px 8px;
      cursor: pointer;
    }
    #${WIDGET_ID} button:hover:enabled {
      border-color: #a78bfa;
    }
    #${WIDGET_ID} button:disabled {
      opacity: 0.45;
      cursor: default;
    }
  `;
  document.head.appendChild(style);
}

function buildWidget(): Widget {
  ensureStyles();

  const root = document.createElement("div");
  root.id = WIDGET_ID;

  const title = document.createElement("div");
  title.className = "ph-title";
  const dot = document.createElement("span");
  dot.className = "ph-dot";
  const name = document.createElement("span");
  name.textContent = "Phonon Reader";
  title.append(dot, name);

  const status = document.createElement("p");
  status.className = "ph-status";

  const progress = document.createElement("p");
  progress.className = "ph-progress";

  const error = document.createElement("p");
  error.className = "ph-error";

  const actions = document.createElement("div");
  actions.className = "ph-actions";
  const toggle = document.createElement("button");
  toggle.textContent = "⏸ Pause";
  const stop = document.createElement("button");
  stop.textContent = "■ Stop";
  actions.append(toggle, stop);

  root.append(title, status, progress, error, actions);
  document.body.appendChild(root);

  const w: Widget = { root, status, progress, error, toggle, stop };
  // Expose the dot for class updates without another query.
  (w as Widget & { dot: HTMLElement }).dot = dot;

  toggle.addEventListener("click", () => {
    void chrome.runtime.sendMessage({
      type: lastPhase === "paused" ? "RESUME" : "PAUSE",
      probeSelection: false,
    });
  });
  stop.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "STOP", probeSelection: false });
  });

  return w;
}

function removeWidget(): void {
  widget?.root.remove();
  widget = null;
  clearSentenceHighlight();
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function refresh(): Promise<void> {
  let app: AppState;
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "GET_STATE",
      probeSelection: false,
    })) as { app: AppState };
    app = response.app;
  } catch {
    removeWidget();
    return;
  }

  if (app.phase === "idle") {
    if (app.error && Date.now() < errorHoldUntil) {
      if (!widget) {
        widget = buildWidget();
      }
      widget.status.textContent = "Failed";
      widget.progress.textContent = "";
      widget.error.textContent = app.error;
      return;
    }
    removeWidget();
    return;
  }

  if (!widget) {
    widget = buildWidget();
  }
  lastPhase = app.phase;
  const w = widget as Widget & { dot: HTMLElement };
  w.dot.className = `ph-dot ${app.phase === "paused" ? "paused" : "active"}`;
  w.status.textContent = PHASE_LABEL[app.phase];
  w.progress.textContent =
    app.chunkCount > 0
      ? `Chunk ${app.chunkIndex + 1} of ${app.chunkCount}`
      : "";
  w.error.textContent = app.error ?? "";
  w.toggle.textContent = app.phase === "paused" ? "▶ Resume" : "⏸ Pause";
  w.toggle.disabled = app.phase !== "playing" && app.phase !== "paused";
  w.stop.disabled = false;
}

function main(): void {
  if (document.getElementById(WIDGET_ID)) {
    return; // already injected
  }
  errorHoldUntil = Date.now() + 5000; // surface a just-failed session briefly
  loadNodeMap();

  // Highlight commands from the service worker.
  chrome.runtime.onMessage.addListener((message: HighlightMessage) => {
    if (message.type === "HIGHLIGHT") {
      paintSentence(message.start, message.end);
    } else if (message.type === "HIGHLIGHT_CLEAR") {
      clearSentenceHighlight();
    }
    return false;
  });

  void refresh();
  pollTimer = window.setInterval(() => void refresh(), POLL_MS);
}

main();

export {};
