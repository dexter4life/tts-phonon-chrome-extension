/**
 * Splits page text into chunks that each fit the speech endpoint's input cap,
 * and records every sentence's character span within the full text so playback
 * position can be translated into "which sentence is being spoken".
 *
 * Splits prefer paragraph breaks, then sentence ends, then hard cuts, so the
 * spoken audio pauses at natural places between chunks.
 */

/** A sentence's character span within the full extracted text. */
export interface SentenceSpan {
  start: number;
  end: number;
}

export interface ChunkPlan {
  chunks: string[];
  /** Sentence spans, in reading order, over the full text. */
  sentences: SentenceSpan[];
  /**
   * For each chunk, the index range [first, last) of `sentences` it contains.
   * Chunk i covers sentences[first] .. sentences[last - 1].
   */
  chunkSentenceRanges: { first: number; last: number }[];
}

export function planChunks(text: string, limit: number): ChunkPlan {
  const sentences = collectSentences(text);
  const chunks: string[] = [];
  const chunkSentenceRanges: { first: number; last: number }[] = [];

  let current = "";
  let currentFirst = 0;

  const flush = (lastExclusive: number): void => {
    if (current.length > 0) {
      chunks.push(current);
      chunkSentenceRanges.push({ first: currentFirst, last: lastExclusive });
      current = "";
    }
  };

  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = text.slice(sentences[i].start, sentences[i].end);
    if (sentence.length > limit) {
      // Oversized sentence: flush what we have, then emit hard-cut pieces.
      flush(i);
      const pieces = hardCut(sentence, limit);
      for (const piece of pieces) {
        chunks.push(piece);
        chunkSentenceRanges.push({ first: i, last: i + 1 });
      }
      continue;
    }
    if (current.length === 0) {
      current = sentence;
      currentFirst = i;
    } else if (`${current} ${sentence}`.length <= limit) {
      current = `${current} ${sentence}`;
    } else {
      flush(i);
      current = sentence;
      currentFirst = i;
    }
  }
  flush(sentences.length);

  return { chunks, sentences, chunkSentenceRanges };
}

/**
 * Finds sentence boundaries as character offsets. Paragraph breaks (blank
 * lines) always end a sentence; within a paragraph, sentence-ending punctuation
 * followed by whitespace does.
 */
function collectSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  const pattern = /[^.!?…\n]+(?:[.!?…]+["')\]]*|\n\n+|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0];
    // Trim leading/trailing whitespace but keep offsets pointing at content.
    const leading = raw.length - raw.trimStart().length;
    const start = match.index + leading;
    const end = match.index + raw.trimEnd().length;
    if (end > start && /[a-zA-Z0-9]/.test(text.slice(start, end))) {
      spans.push({ start, end });
    }
  }
  return spans;
}

function hardCut(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = window.lastIndexOf(" ");
    const splitAt = cut > limit * 0.6 ? cut : limit;
    pieces.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest.length > 0) {
    pieces.push(rest);
  }
  return pieces;
}
