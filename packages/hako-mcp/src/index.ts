import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Hako } from "hako-db";
import { startServer } from "./server.js";
import { getProject } from "./project.js";
import { parseTranscript, type TranscriptFormat } from "./transcript.js";

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "serve":
    await startServer();
    break;

  case "save-transcript":
    await saveTranscript();
    break;

  default:
    console.error("Usage: hako-mcp <serve|save-transcript> [options]");
    console.error("");
    console.error("Commands:");
    console.error("  serve             Start MCP server (stdio)");
    console.error("  save-transcript   Read JSONL transcript from stdin and save Q&A chunks");
    console.error("");
    console.error("Options:");
    console.error("  --namespace <path>  Namespace/project path (default: git root of cwd)");
    console.error("  --format <format>   Transcript format: auto, claude, codex (default: auto)");
    process.exit(1);
}

async function saveTranscript(): Promise<void> {
  const namespace = getFlagValue("--namespace") ?? getProject();
  const format = parseFormat(getFlagValue("--format") ?? "auto");

  const lines: string[] = [];

  if (process.stdin.isTTY) {
    const fileArg = getFileArg();
    if (!fileArg) {
      console.error("Error: provide transcript via stdin or as file argument");
      process.exit(1);
    }
    const rl = createInterface({ input: createReadStream(fileArg) });
    for await (const line of rl) {
      lines.push(line);
    }
  } else {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      lines.push(line);
    }
  }

  const text = lines.join("\n");
  const chunks = parseTranscript(text, format);

  if (chunks.length === 0) {
    console.error("No Q&A chunks found in transcript");
    return;
  }

  const hako = new Hako({ dbPath: process.env.HAKO_DB });
  let saved = 0;
  let skipped = 0;

  try {
    for (const chunk of chunks) {
      const result = await hako.save({
        title: chunk.content.slice(0, 200),
        content: chunk.content,
        tags: chunk.tags,
        namespace,
        scope: "default",
        priority: "normal",
        source: "transcript",
      });

      if (result.status === "created") {
        saved++;
      } else {
        skipped++;
      }
    }
  } finally {
    hako.close();
  }

  console.error(
    `save-transcript: Saved ${saved} chunks, skipped ${skipped} (namespace: ${namespace})`,
  );
}

function getFlagValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function getFileArg(): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--namespace" || arg === "--format") {
      i++;
      continue;
    }
    if (!arg.startsWith("--")) return arg;
  }

  return undefined;
}

function parseFormat(format: string): TranscriptFormat {
  if (format === "auto" || format === "claude" || format === "codex") {
    return format;
  }

  console.error("Error: --format must be one of: auto, claude, codex");
  process.exit(1);
}
