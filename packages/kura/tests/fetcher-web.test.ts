import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchPage } from "../src/fetchers/web.js";

describe("fetchPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts title from og:title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        url: "https://example.com",
        text: () =>
          Promise.resolve(`
          <html>
            <head>
              <meta property="og:title" content="OG Title" />
              <title>Page Title</title>
            </head>
            <body><p>Content here</p></body>
          </html>
        `),
      }),
    );

    const page = await fetchPage("https://example.com");
    expect(page.title).toBe("OG Title");
  });

  it("falls back to <title> when no og:title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        url: "https://example.com",
        text: () =>
          Promise.resolve(`
          <html>
            <head><title>Page Title</title></head>
            <body><p>Content</p></body>
          </html>
        `),
      }),
    );

    const page = await fetchPage("https://example.com");
    expect(page.title).toBe("Page Title");
  });

  it("extracts content from og:description", async () => {
    const longDesc = "A".repeat(100);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        url: "https://example.com",
        text: () =>
          Promise.resolve(`
          <html>
            <head>
              <meta property="og:description" content="${longDesc}" />
            </head>
            <body><p>Body text</p></body>
          </html>
        `),
      }),
    );

    const page = await fetchPage("https://example.com");
    expect(page.content).toBe(longDesc);
  });

  it("extracts body text when no meta description", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        url: "https://example.com",
        text: () =>
          Promise.resolve(`
          <html>
            <head><title>Test</title></head>
            <body>
              <nav>Navigation</nav>
              <article><p>Article content here</p></article>
              <footer>Footer</footer>
            </body>
          </html>
        `),
      }),
    );

    const page = await fetchPage("https://example.com");
    expect(page.content).toContain("Article content");
    expect(page.content).not.toContain("Navigation");
    expect(page.content).not.toContain("Footer");
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
