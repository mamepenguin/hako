import { describe, it, expect } from "vitest";
import { parseTranscript } from "../src/transcript.js";

describe("parseTranscript", () => {
  it("parses JSONL transcript into Q&A chunks", () => {
    const transcript = [
      JSON.stringify({
        type: "user",
        message: { content: "What is TypeScript?" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "TypeScript is a typed superset of JavaScript that compiles to plain JavaScript." },
          ],
        },
      }),
    ].join("\n");

    const chunks = parseTranscript(transcript);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("Q: What is TypeScript?");
    expect(chunks[0].content).toContain("A: TypeScript is a typed superset");
  });

  it("ignores tool_use and thinking blocks", () => {
    const transcript = [
      JSON.stringify({
        type: "user",
        message: { content: "Fix the bug in auth.ts" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", text: "Let me think about this..." },
            { type: "tool_use", name: "read_file", input: { path: "auth.ts" } },
            { type: "text", text: "I found and fixed the bug in the authentication logic." },
          ],
        },
      }),
    ].join("\n");

    const chunks = parseTranscript(transcript);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).not.toContain("thinking");
    expect(chunks[0].content).toContain("A: I found and fixed the bug");
  });

  it("skips chunks shorter than 50 characters", () => {
    const transcript = [
      JSON.stringify({
        type: "user",
        message: { content: "Hi" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello!" }] },
      }),
    ].join("\n");

    const chunks = parseTranscript(transcript);
    expect(chunks).toHaveLength(0);
  });

  it("combines consecutive assistant messages", () => {
    const transcript = [
      JSON.stringify({
        type: "user",
        message: { content: "Explain the search algorithm in detail please" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "The search uses FTS5 for keyword matching." }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "It also uses vec0 for semantic similarity." }] },
      }),
    ].join("\n");

    const chunks = parseTranscript(transcript);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("FTS5");
    expect(chunks[0].content).toContain("vec0");
  });

  it("ignores non-user/assistant types", () => {
    const transcript = [
      JSON.stringify({ type: "system", message: { content: "System message" } }),
      JSON.stringify({ type: "progress", message: { content: "Loading..." } }),
      JSON.stringify({
        type: "user",
        message: { content: "How does the embedding cache work in this project?" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "The embedding cache uses SHA256 hashes as keys to avoid recomputing vectors." }] },
      }),
    ].join("\n");

    const chunks = parseTranscript(transcript);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("SHA256");
  });

  it("returns empty array for empty input", () => {
    expect(parseTranscript("")).toHaveLength(0);
    expect(parseTranscript("invalid json\nnot jsonl")).toHaveLength(0);
  });

  it("handles user content as list of blocks", () => {
    const transcript = [
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "text", text: "Here is my question about the database schema and indexes" },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "The schema uses three tables: entries, entries_fts, and entries_vec." }] },
      }),
    ].join("\n");

    const chunks = parseTranscript(transcript);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("Q: Here is my question");
  });

  it("parses Codex rollout JSONL into Q&A chunks", () => {
    const transcript = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          originator: "Codex Desktop",
          cwd: "/Users/libre/Sources/LifeBrain",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "# AGENTS.md instructions\nInjected context that should not be saved" },
          ],
        },
      }),
      JSON.stringify({
        type: "turn_context",
        payload: { cwd: "/Users/libre/Sources/LifeBrain" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Please add Codex transcript support to hako-mcp" },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: "{}",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "I added Codex rollout parsing while preserving Claude transcript support." },
          ],
        },
      }),
    ].join("\n");

    const chunks = parseTranscript(transcript);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("Q: Please add Codex transcript support");
    expect(chunks[0].content).toContain("A: I added Codex rollout parsing");
    expect(chunks[0].content).not.toContain("AGENTS.md");
    expect(chunks[0].content).not.toContain("function_call");
  });

  it("supports explicit transcript format selection", () => {
    const transcript = [
      JSON.stringify({ type: "turn_context", payload: {} }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "How should explicit Codex parsing behave?" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "It should parse only when the codex format is selected." }],
        },
      }),
    ].join("\n");

    expect(parseTranscript(transcript, "claude")).toHaveLength(0);
    expect(parseTranscript(transcript, "codex")).toHaveLength(1);
  });

  it("combines Codex assistant messages across tool calls until the next user turn", () => {
    const transcript = [
      JSON.stringify({ type: "turn_context", payload: {} }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Explain how Codex transcript ingestion works in detail" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Codex stores rollout JSONL under the sessions directory." }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          output: "tool output should be ignored",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The parser reads response_item message payloads only." }],
        },
      }),
      JSON.stringify({
        type: "turn_context",
        payload: {},
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Thanks" }],
        },
      }),
    ].join("\n");

    const chunks = parseTranscript(transcript);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("sessions directory");
    expect(chunks[0].content).toContain("response_item message payloads");
    expect(chunks[0].content).not.toContain("tool output should be ignored");
  });
});
