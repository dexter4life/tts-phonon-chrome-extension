/**
 * Page text extraction. These functions are injected straight into the page by
 * the service worker (chrome.scripting.executeScript serializes their source),
 * so they must be fully self-contained: no references to module scope, only
 * DOM APIs. Keep them dependency-free.
 *
 * Extraction produces the spoken text plus a node map: for every text node that
 * contributed characters, its DOM node and the character range it covers in the
 * extracted text. The service worker uses this to translate character offsets
 * (sentence spans) back into DOM ranges for highlighting.
 */
/** One text node's contribution to the extracted text. */
export interface NodeSpan {
  /** Index into the flattened text-node list at extraction time. */
  nodeIndex: number;
  /** Start offset of this node's characters within the extracted text. */
  start: number;
  /** End offset (exclusive) within the extracted text. */
  end: number;
}

export interface ExtractWithMap {
  ok: true;
  text: string;
  title: string;
  /** Flattened text nodes, in document order. */
  nodes: Node[];
  /** Which extracted-text range each node covers. */
  spans: NodeSpan[];
}

type RawExtract =
  | ExtractWithMap
  | { ok: false; reason: "noselection" | "empty" | "restricted" | "failed" };

/**
 * Window key under which the extraction stashes its node map so the overlay
 * (same page context) can translate character offsets into DOM ranges. Node
 * objects cannot be serialized to the service worker, so the map stays here.
 * The key literal is duplicated inside extractInPage because injected functions
 * must be fully self-contained.
 */

/** Injected to read the user's current text selection, if any. */
export function extractInPage(mode: "page" | "selection"): RawExtract {
  function innerTextOf(element: Element): string {
    const html = element as HTMLElement;
    return html.innerText ?? element.textContent ?? "";
  }

  if (mode === "selection") {
    const selection = window.getSelection();
    if (
      selection === null ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      return { ok: false, reason: "noselection" };
    }
    const text = selection.toString().trim();
    if (text.length === 0) {
      return { ok: false, reason: "noselection" };
    }

    // Map the selected text nodes so the sentence highlighter can find them.
    const range = selection.getRangeAt(0);
    const nodes: Node[] = [];
    const spans: NodeSpan[] = [];
    let offset = 0;
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
    );
    let node = walker.nextNode();
    while (node !== null) {
      const value = node.nodeValue ?? "";
      if (value.length > 0 && range.intersectsNode(node)) {
        const from = range.startContainer === node ? range.startOffset : 0;
        const to = range.endContainer === node ? range.endOffset : value.length;
        const slice = value.slice(from, to);
        if (slice.trim().length > 0) {
          nodes.push(node);
          spans.push({
            nodeIndex: nodes.length - 1,
            start: offset,
            end: offset + slice.length,
          });
          offset += slice.length;
        }
      }
      node = walker.nextNode();
    }
    (window as unknown as Record<string, unknown>)["__phononNodeMap"] = {
      nodes,
      spans,
    };
    return { ok: true, text, title: document.title, nodes, spans };
  }

  // Full-page mode: pick the main content container, then map its text nodes.
  const selectors = [
    "article",
    "main",
    '[role="main"]',
    ".post",
    ".article-body",
    "#content",
  ];
  let container: Element | null = null;
  for (const selector of selectors) {
    let best: Element | null = null;
    let bestLength = 0;
    for (const element of document.querySelectorAll(selector)) {
      const length = innerTextOf(element).trim().length;
      if (length > bestLength) {
        best = element;
        bestLength = length;
      }
    }
    if (best !== null && bestLength > 280) {
      container = best;
      break;
    }
  }
  if (container === null) {
    container = document.body;
  }

  const nodes: Node[] = [];
  const spans: NodeSpan[] = [];
  let text = "";
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    const value = node.nodeValue ?? "";
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length > 0) {
      nodes.push(node);
      spans.push({
        nodeIndex: nodes.length - 1,
        start: text.length,
        end: text.length + trimmed.length,
      });
      text += `${trimmed} `;
    }
    node = walker.nextNode();
  }

  text = text.trim();
  if (text.length === 0) {
    return { ok: false, reason: "empty" };
  }
  (window as unknown as Record<string, unknown>)["__phononNodeMap"] = {
    nodes,
    spans,
  };
  return { ok: true, text, title: document.title, nodes, spans };
}

/** Injected to cheaply detect whether the active tab has a text selection. */
export function probeSelectionInPage(): boolean {
  const selection = window.getSelection();
  return (
    selection !== null &&
    !selection.isCollapsed &&
    selection.toString().trim().length > 0
  );
}
