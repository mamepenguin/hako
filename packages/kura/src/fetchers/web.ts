import * as cheerio from "cheerio";
import type { PageInfo } from "../types.js";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) kura/0.1",
  Accept: "text/html,application/xhtml+xml",
};

const TIMEOUT_MS = 15000;
const MAX_CONTENT_CHARS = 2000;

export async function fetchPage(
  url: string,
  maxContentChars: number = MAX_CONTENT_CHARS,
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
    const $ = cheerio.load(html);

    const title = extractTitle($) || url;
    const content = extractContent($, maxContentChars);

    return { title, content, url: resp.url };
  } finally {
    clearTimeout(timer);
  }
}

function extractTitle($: cheerio.CheerioAPI): string {
  const og = $('meta[property="og:title"]').attr("content");
  if (og?.trim()) return og.trim();

  const titleTag = $("title").text();
  if (titleTag?.trim()) return titleTag.trim();

  const h1 = $("h1").first().text();
  if (h1?.trim()) return h1.trim();

  return "";
}

function extractContent(
  $: cheerio.CheerioAPI,
  maxChars: number,
): string {
  const ogDesc = $('meta[property="og:description"]').attr("content");
  if (ogDesc?.trim() && ogDesc.trim().length > 50) {
    return ogDesc.trim().slice(0, maxChars);
  }

  const metaDesc = $('meta[name="description"]').attr("content");
  if (metaDesc?.trim() && metaDesc.trim().length > 50) {
    return metaDesc.trim().slice(0, maxChars);
  }

  const container =
    $("article").first().length > 0
      ? $("article").first()
      : $("main").first().length > 0
        ? $("main").first()
        : $("body").first();

  if (container.length === 0) return "";

  container
    .find("script, style, nav, header, footer, aside")
    .remove();

  const text = container.text();
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return lines.join("\n").slice(0, maxChars);
}
