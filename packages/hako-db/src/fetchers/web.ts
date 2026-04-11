import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { PageInfo } from "../types.js";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) hako/0.1",
  Accept: "text/html,application/xhtml+xml",
};

const TIMEOUT_MS = 15000;
const DEFAULT_MAX_CONTENT_CHARS = 8000;
const MIN_ARTICLE_CONTENT_CHARS = 200;
const MIN_META_DESC_CHARS = 50;
const READABILITY_CHAR_THRESHOLD = 200;

type LinkedomDocument = ReturnType<typeof parseHTML>["document"];

export async function fetchPage(
  url: string,
  maxContentChars: number = DEFAULT_MAX_CONTENT_CHARS,
): Promise<PageInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      headers: HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }

    const html = await resp.text();
    const { document } = parseHTML(html);

    const readable = extractReadableContent(html, maxContentChars);
    const title = extractTitle(document) || readable?.title || url;
    const content =
      readable?.content ?? extractFallbackContent(document, maxContentChars);

    return { title, content, url: resp.url };
  } finally {
    clearTimeout(timer);
  }
}

interface ReadableResult {
  readonly title: string;
  readonly content: string;
}

function extractReadableContent(
  html: string,
  maxChars: number,
): ReadableResult | null {
  try {
    // Parse a dedicated Document for Readability because it mutates the DOM
    // during parse(). Keeping a separate tree avoids interfering with the
    // fallback extractor, which uses its own Document.
    const { document } = parseHTML(html);
    // Readability's type expects a standard DOM Document; linkedom's Document
    // is compatible at runtime but not nominally assignable.
    const article = new Readability(document as unknown as Document, {
      charThreshold: READABILITY_CHAR_THRESHOLD,
    }).parse();

    if (!article) return null;

    const content = normalizeWhitespace(article.textContent ?? "").slice(
      0,
      maxChars,
    );

    if (content.length < MIN_ARTICLE_CONTENT_CHARS) return null;

    return {
      title: (article.title ?? "").trim(),
      content,
    };
  } catch {
    return null;
  }
}

function extractTitle(document: LinkedomDocument): string {
  const og = document
    .querySelector('meta[property="og:title"]')
    ?.getAttribute("content");
  if (og && og.trim()) return og.trim();

  const titleTag = document.querySelector("title")?.textContent;
  if (titleTag && titleTag.trim()) return titleTag.trim();

  const h1 = document.querySelector("h1")?.textContent;
  if (h1 && h1.trim()) return h1.trim();

  return "";
}

function extractFallbackContent(
  document: LinkedomDocument,
  maxChars: number,
): string {
  // Strip noise elements once for the whole document. <head> is preserved,
  // so meta tags remain available for the meta-description fallbacks below.
  const noise = document.querySelectorAll(
    "script, style, nav, header, footer, aside",
  );
  noise.forEach((node) => node.remove());

  for (const selector of ["article", "main", "body"] as const) {
    const el = document.querySelector(selector);
    if (!el) continue;

    const text = normalizeWhitespace(el.textContent ?? "");
    if (text.length >= MIN_ARTICLE_CONTENT_CHARS) {
      return text.slice(0, maxChars);
    }
  }

  const ogDesc = document
    .querySelector('meta[property="og:description"]')
    ?.getAttribute("content");
  if (ogDesc && ogDesc.trim().length >= MIN_META_DESC_CHARS) {
    return ogDesc.trim().slice(0, maxChars);
  }

  const metaDesc = document
    .querySelector('meta[name="description"]')
    ?.getAttribute("content");
  if (metaDesc && metaDesc.trim().length >= MIN_META_DESC_CHARS) {
    return metaDesc.trim().slice(0, maxChars);
  }

  return "";
}

function normalizeWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}
