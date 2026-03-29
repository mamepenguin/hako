import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Hako } from "hako-db";
import { startServer } from "./server.js";
import { getProject } from "./project.js";
import { parseTranscript } from "./transcript.js";

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
    process.exit(1);
}

async function saveTranscript(): Promise<void> {
  const nsFlag = args.indexOf("--namespace");
  const namespace = nsFlag >= 0 && args[nsFlag + 1]
    ? args[nsFlag + 1]
    : getProject();

  const lines: string[] = [];

  if (process.stdin.isTTY) {
    // Read from file argument if provided
    const fileArg = args[1];
    if (!fileArg || fileArg.startsWith("--")) {
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
  const chunks = parseTranscript(text);

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
