/**
 * Popup controller: renders session state from the service worker and forwards
 * button presses as runtime messages. The state itself lives in the service
 * worker; the popup stays a thin view.
 */
import {
  type AppState,
  type ReadMode,
  type StateResponse,
} from "../shared/messages";

const STATUS_LABEL: Record<AppState["phase"], string> = {
  idle: "Idle",
  extracting: "Reading page…",
  loading: "Generating audio…",
  playing: "Playing",
  paused: "Paused",
};

const elements = {
  dot: document.querySelector('[data-testid="status-dot"]') as HTMLElement,
  status: document.querySelector('[data-testid="status"]') as HTMLElement,
  progress: document.querySelector('[data-testid="progress"]') as HTMLElement,
  error: document.getElementById("error") as HTMLElement,
  readPage: document.getElementById("read-page") as HTMLButtonElement,
  readSelection: document.getElementById("read-selection") as HTMLButtonElement,
  pause: document.getElementById("pause") as HTMLButtonElement,
  resume: document.getElementById("resume") as HTMLButtonElement,
  stop: document.getElementById("stop") as HTMLButtonElement,
};

let hasSelection = false;

type SendPayload =
  | { type: "READ"; mode: ReadMode }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "STOP" }
  | { type: "GET_STATE" };

async function send(
  message: SendPayload,
  probeSelection = false,
): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    ...message,
    probeSelection,
  })) as StateResponse;
  apply(response);
}

function apply({ app, hasSelection: selection }: StateResponse): void {
  hasSelection = selection;

  elements.status.textContent = app.error ? "Failed" : STATUS_LABEL[app.phase];
  elements.dot.className = `status-dot ${app.error ? "error" : app.phase}`;

  const busy = app.phase !== "idle";
  elements.readPage.disabled = busy;
  elements.readSelection.disabled = busy || !hasSelection;
  elements.pause.disabled = app.phase !== "playing";
  elements.pause.hidden = app.phase !== "playing" && app.phase !== "paused";
  elements.resume.hidden = app.phase !== "paused";
  elements.stop.disabled = !busy;

  elements.progress.textContent =
    busy && app.chunkCount > 0
      ? `Chunk ${app.chunkIndex + 1} of ${app.chunkCount}`
      : "";
  elements.error.textContent = app.error ?? "";
}

elements.readPage.addEventListener(
  "click",
  () => void send({ type: "READ", mode: "page" as ReadMode }, true),
);
elements.readSelection.addEventListener(
  "click",
  () => void send({ type: "READ", mode: "selection" as ReadMode }, true),
);
elements.pause.addEventListener("click", () => void send({ type: "PAUSE" }));
elements.resume.addEventListener("click", () => void send({ type: "RESUME" }));
elements.stop.addEventListener("click", () => void send({ type: "STOP" }));

// Refresh state and selection while the popup is open.
window.setInterval(() => void send({ type: "GET_STATE" }, true), 400);
void send({ type: "GET_STATE" }, true);
