/**
 * Offscreen playback document. The MV3 service worker cannot play audio, so it
 * sends commands over a long-lived runtime port; this document fetches the WAV
 * for each chunk straight from the local Ollama speech endpoint, patches the
 * WAV size fields (phonon streams, so its header carries placeholder sizes),
 * and plays it with an <audio> element. Playback events go back on the port,
 * and periodic keep-alive pings prevent the service worker from idling out
 * during long playback sessions.
 */
import type { PlaybackCommand, PlaybackEvent } from "../shared/messages";
import { SPEECH_ENDPOINT, TTS_MODEL } from "../shared/config";

let audio: HTMLAudioElement | null = null;
let currentChunkId = -1;
let currentChunkText = "";
let objectUrl: string | null = null;
let fetchAbort: AbortController | null = null;
let port: chrome.runtime.Port | null = null;

function post(event: PlaybackEvent): void {
  if (!port) {
    return;
  }
  try {
    port.postMessage(event);
  } catch {
    // Port already closed; the worker treats a disconnect as a stop request.
  }
}

function releaseAudio(): void {
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audio = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  currentChunkId = -1;
  currentChunkText = "";
}

/**
 * phonon streams audio, so its WAV header carries sentinel (max-value) size
 * fields. Rewrite both size fields with the actual byte counts so the
 * <audio> element computes a correct duration.
 */
function patchWavSizes(buffer: ArrayBuffer): Blob {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  let dataOffset = 44; // canonical PCM layout fallback
  for (
    let offset = 12;
    offset < Math.min(view.byteLength - 8, 4096);
    offset += 1
  ) {
    if (
      view.getUint8(offset) === 0x64 && // d
      view.getUint8(offset + 1) === 0x61 && // a
      view.getUint8(offset + 2) === 0x74 && // t
      view.getUint8(offset + 3) === 0x61 // a
    ) {
      dataOffset = offset;
      break;
    }
  }

  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(dataOffset + 4, bytes.length - dataOffset - 8, true);
  return new Blob([bytes], { type: "audio/wav" });
}

async function playChunk(id: number, text: string): Promise<void> {
  releaseAudio();
  fetchAbort = new AbortController();
  currentChunkId = id;
  currentChunkText = text;

  let blob: Blob;
  try {
    const response = await fetch(SPEECH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: fetchAbort.signal,
      body: JSON.stringify({
        model: TTS_MODEL,
        input: text,
        response_format: "wav",
      }),
    });
    if (response.status === 400) {
      const detail = await response.text();
      throw new Error(
        `Ollama rejected the request (400): ${detail.slice(0, 300)}`,
      );
    }
    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < 100) {
      throw new Error("Ollama returned an empty audio response.");
    }
    blob = patchWavSizes(buffer);
  } catch (error) {
    if (fetchAbort.signal.aborted) {
      return; // STOP superseded this chunk; report nothing.
    }
    post({
      type: "CHUNK_ERROR",
      id,
      error:
        error instanceof TypeError
          ? "Could not reach Ollama at localhost:11434. Is Ollama running, and was it started with OLLAMA_ORIGINS=chrome-extension://*?"
          : error instanceof Error
            ? error.message
            : String(error),
    });
    return;
  }

  if (currentChunkId !== id) {
    return; // STOP cleared the session mid-fetch.
  }

  objectUrl = URL.createObjectURL(blob);
  const element = new Audio(objectUrl);
  audio = element;

  // Report playback position so the worker can highlight the current sentence.
  // Speech duration is roughly proportional to character count; the audio
  // element's currentTime/duration ratio maps onto the chunk's text.
  let lastReported = -1;
  element.addEventListener("timeupdate", () => {
    const duration = element.duration;
    if (
      currentChunkId !== id ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      currentChunkText.length === 0
    ) {
      return;
    }
    const ratio = Math.min(element.currentTime / duration, 1);
    const charIndex = Math.floor(ratio * currentChunkText.length);
    if (charIndex !== lastReported) {
      lastReported = charIndex;
      post({ type: "CHUNK_PROGRESS", id, charIndex });
    }
  });

  const finished = new Promise<void>((resolve) => {
    element.addEventListener("ended", () => resolve(), { once: true });
    element.addEventListener("error", () => resolve(), { once: true });
  });

  try {
    await element.play();
  } catch (error) {
    post({
      type: "CHUNK_ERROR",
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    releaseAudio();
    return;
  }

  await finished;

  if (currentChunkId !== id) {
    return; // STOP superseded the chunk while it played.
  }
  const failed = element.error !== null;
  releaseAudio();
  if (failed) {
    post({ type: "CHUNK_ERROR", id, error: "audio element reported an error" });
  } else {
    post({ type: "CHUNK_ENDED", id });
  }
}

chrome.runtime.onConnect.addListener((incoming) => {
  if (incoming.name !== "playback") {
    return;
  }
  port = incoming;
  port.onMessage.addListener((command: PlaybackCommand) => {
    switch (command.type) {
      case "PLAY_CHUNK": {
        void playChunk(command.id, command.text);
        return;
      }
      case "PAUSE": {
        audio?.pause();
        return;
      }
      case "RESUME": {
        void audio?.play().catch(() => {
          // Resume can race a STOP; the worker's session state stays authoritative.
        });
        return;
      }
      case "STOP": {
        fetchAbort?.abort();
        releaseAudio();
        return;
      }
    }
  });
  port.onDisconnect.addListener(() => {
    fetchAbort?.abort();
    releaseAudio();
    port = null;
  });
});

// Keep-alive pings: the offscreen document is long-lived, but the service
// worker times out after ~30 idle seconds; without these pings the worker dies
// mid-session and multi-chunk playback would stall.
setInterval(() => {
  try {
    chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" }).catch(() => {
      // Worker restarting; it re-establishes the port when it wakes.
    });
  } catch {
    // Extension context invalidated (extension reloaded); nothing to do.
  }
}, 10_000);
