import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchPage } from "../src/fetchers/web.js";

function mockFetchOk(html: string, url = "https://example.com"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      url,
      text: () => Promise.resolve(html),
    }),
  );
}

const ARTICLE_HTML = `
  <html>
    <head><title>Article Page Title</title></head>
    <body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <article>
        <h1>Main Headline</h1>
        <p>This is the first paragraph of the main article content. It contains enough words to be recognized as substantive article material by the readability heuristics used in the extractor.</p>
        <p>Here is the second paragraph with even more content to ensure the article element clearly wins against the navigation and footer sections of the page layout.</p>
        <p>A third paragraph rounds out the article body with additional text to comfortably exceed any minimum character threshold used to determine reader mode suitability.</p>
      </article>
      <footer>Copyright 2026 Example Site</footer>
    </body>
  </html>
`;

describe("fetchPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts title from og:title", async () => {
    mockFetchOk(`
      <html>
        <head>
          <meta property="og:title" content="OG Title" />
          <title>Page Title</title>
        </head>
        <body><p>Content here</p></body>
      </html>
    `);

    const page = await fetchPage("https://example.com");
    expect(page.title).toBe("OG Title");
  });

  it("falls back to <title> when no og:title", async () => {
    mockFetchOk(`
      <html>
        <head><title>Page Title</title></head>
        <body><p>Content</p></body>
      </html>
    `);

    const page = await fetchPage("https://example.com");
    expect(page.title).toBe("Page Title");
  });

  it("extracts article body with Readability", async () => {
    mockFetchOk(ARTICLE_HTML);

    const page = await fetchPage("https://example.com");

    expect(page.title).toBe("Article Page Title");
    expect(page.content).toContain("first paragraph");
    expect(page.content).toContain("second paragraph");
    expect(page.content).toContain("third paragraph");
    expect(page.content).not.toContain("Home");
    expect(page.content).not.toContain("Copyright 2026");
  });

  it("extracts body text when no article tag is present", async () => {
    const bodyParagraph =
      "This is a long paragraph inside the body element intended to simulate article content that lives outside any dedicated article tag but still provides enough substance to pass the minimum character threshold used by the fallback extractor.";
    mockFetchOk(`
      <html>
        <head><title>Test</title></head>
        <body>
          <div>${bodyParagraph}</div>
        </body>
      </html>
    `);

    const page = await fetchPage("https://example.com");
    expect(page.content).toContain("long paragraph inside the body");
  });

  it("falls back to og:description when body has no substantive content", async () => {
    const ogDesc =
      "Open Graph description used as a last-resort fallback when the page body does not contain enough text to satisfy the article extractor thresholds.";
    mockFetchOk(`
      <html>
        <head>
          <title>Bare Page</title>
          <meta property="og:description" content="${ogDesc}" />
        </head>
        <body><p>Too short</p></body>
      </html>
    `);

    const page = await fetchPage("https://example.com");
    expect(page.content).toBe(ogDesc);
  });

  it("falls back to meta description when og:description missing", async () => {
    const metaDesc =
      "Standard meta description used when Open Graph metadata is not provided by the page and the body contains no substantive readable content.";
    mockFetchOk(`
      <html>
        <head>
          <title>Bare Page</title>
          <meta name="description" content="${metaDesc}" />
        </head>
        <body><p>Short</p></body>
      </html>
    `);

    const page = await fetchPage("https://example.com");
    expect(page.content).toBe(metaDesc);
  });

  it("respects maxContentChars second argument", async () => {
    mockFetchOk(ARTICLE_HTML);

    const page = await fetchPage("https://example.com", 300);
    expect(page.content.length).toBeLessThanOrEqual(300);
    expect(page.content.length).toBeGreaterThan(0);
  });

  it("returns the final URL after redirects", async () => {
    mockFetchOk(ARTICLE_HTML, "https://example.com/final-location");

    const page = await fetchPage("https://example.com/initial");
    expect(page.url).toBe("https://example.com/final-location");
  });

  it("throws on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      }),
    );

    await expect(fetchPage("https://example.com/404")).rejects.toThrow(
      "HTTP 404",
    );
  });
});
