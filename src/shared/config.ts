/** Local Ollama server. Configurable later via an options page if needed. */
export const OLLAMA_BASE_URL = "http://localhost:11434";

/** Ollama's phonon text-to-speech model family. */
export const TTS_MODEL = "phonon";

/**
 * The speech endpoint accepts at most 4,096 characters of input per request.
 * Stay slightly under the cap so sentence-level padding never trips a 400.
 */
export const MAX_CHUNK_CHARS = 4000;

/** Speech endpoint on the OpenAI-compatible surface of the local server. */
export const SPEECH_ENDPOINT = `${OLLAMA_BASE_URL}/v1/audio/speech`;
