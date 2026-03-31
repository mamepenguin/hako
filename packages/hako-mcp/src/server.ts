import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Hako } from "hako-db";
import type { Scope, Priority, ScopeMode, UpdateInput } from "hako-db";
import { getProject, resolveGitRoot } from "./project.js";

let hako: Hako | null = null;

function getHako(): Hako {
  if (!hako) {
    hako = new Hako({ dbPath: process.env.HAKO_DB });
  }
  return hako;
}

const TOOLS = [
  {
    name: "save",
    description: `Save an entry to long-term memory.

Return status:
- "created": new entry saved
- "updated": existing similar entry updated (deduplicated)
- "skipped": duplicate detected, no action taken. This is normal and expected (e.g. hooks may trigger saves that overlap). Do NOT treat as an error.

Scope:
- "default" (default): entries specific to the current namespace/project
- "global": reusable across all namespaces
  Rule of thumb: if removing the project name still makes it useful, it's "global".

Priority:
- "high" (default): explicitly saved entries. Deduplication uses semantic similarity (cosine >= 0.90).
- "normal": auto-captured entries (e.g. transcripts). Deduplication uses exact content match.

Tags: comma-separated categories (e.g. "auth,jwt", "architecture,db").`,
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Entry title or summary" },
        content: { type: "string", description: "Detailed content (optional)" },
        tags: { type: "string", description: "Comma-separated tags", default: "" },
        namespace: { type: "string", description: "Namespace/project path (defaults to git root of cwd)" },
        scope: { type: "string", enum: ["default", "global"], description: "Visibility scope", default: "default" },
        priority: { type: "string", enum: ["normal", "high"], description: "Entry priority", default: "high" },
        happened_at: { type: "string", description: "When the event occurred (ISO 8601, e.g. '2025-03-15T10:00:00'). Defaults to now. Use for recording past events." },
      },
      required: ["title"],
    },
  },
  {
    name: "search",
    description: `Search entries using hybrid search (keyword + semantic).

Query tips:
- Use short conceptual phrases for best results (e.g. "authentication strategy", "DB selection rationale")
- The vector search excels at finding semantically related entries even with different wording
- The FTS5 trigram search catches partial keyword matches in Japanese and English
- Try multiple related queries if the first search is insufficient

scope_mode controls which entries are searched:
- "scoped_then_global" (default): this namespace's entries + global entries from other namespaces
- "scoped": only this namespace's entries
- "global_only": only global-scoped entries across all namespaces
- "all": unrestricted cross-namespace search

Each result contains: id, title, content, tags, namespace, scope, priority, source, score, created_at, updated_at, happened_at. Use score to gauge relevance (higher is better).`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query text" },
        namespace: { type: "string", description: "Namespace/project path (defaults to git root of cwd)" },
        scope_mode: {
          type: "string",
          enum: ["scoped", "global_only", "scoped_then_global", "all"],
          description: "Search scope mode",
          default: "scoped_then_global",
        },
        source: { type: "string", description: "Filter by source (e.g. 'claude', 'web', 'transcript')" },
        limit: { type: "number", description: "Max results to return", default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "delete",
    description: "Delete a specific entry by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "The ID of the entry to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "prune",
    description: `Delete entries not accessed within N days. DESTRUCTIVE and IRREVERSIBLE.

NEVER run automatically or proactively. Only execute when the user explicitly requests cleanup.
Before running, call stats first and inform the user how many entries may be affected.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        older_than_days: {
          type: "number",
          description: "Delete entries not accessed in this many days",
          default: 90,
        },
      },
    },
  },
  {
    name: "stats",
    description: "Get entry statistics: counts, DB size, namespace breakdown.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "list_namespaces",
    description: "List all namespaces that have stored entries, with counts and last update times.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "update",
    description: `Update an existing entry by ID. Only specified fields are updated.

Omitted fields remain unchanged. Setting content or url to null clears the field.
If title or content changes, the embedding is automatically recomputed.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "The ID of the entry to update" },
        title: { type: "string", description: "New title" },
        content: { type: ["string", "null"] as const, description: "New content (null to clear)" },
        tags: { type: "string", description: "New comma-separated tags" },
        url: { type: ["string", "null"] as const, description: "New URL (null to clear)" },
        scope: { type: "string", enum: ["default", "global"], description: "New visibility scope" },
        priority: { type: "string", enum: ["normal", "high"], description: "New priority" },
        namespace: { type: "string", description: "New namespace" },
        source: { type: "string", description: "New source identifier" },
      },
      required: ["id"],
    },
  },
];

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
}

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const h = getHako();

  switch (name) {
    case "save": {
      const title = requireString(args, "title");
      const ns = (args.namespace as string) || getProject();
      const result = await h.save({
        title,
        content: (args.content as string) ?? undefined,
        tags: (args.tags as string) ?? "",
        namespace: ns,
        scope: ((args.scope as string) ?? "default") as Scope,
        priority: ((args.priority as string) ?? "high") as Priority,
        source: "claude",
        happened_at: (args.happened_at as string) ?? undefined,
      });
      return { status: result.status, id: result.id, namespace: ns, scope: args.scope ?? "default" };
    }

    case "search": {
      const query = requireString(args, "query");
      const ns = (args.namespace as string) || getProject();
      const scopeMode = ((args.scope_mode as string) ?? "scoped_then_global") as ScopeMode;
      const results = await h.search(query, {
        namespace: ns,
        scope_mode: scopeMode,
        source: (args.source as string) ?? undefined,
        limit: (args.limit as number) ?? 10,
      });
      return { results, count: results.length };
    }

    case "delete": {
      if (typeof args.id !== "string") throw new Error("id is required");
      const success = h.delete(args.id as string);
      return success
        ? { status: "deleted", id: args.id }
        : { status: "not_found", id: args.id };
    }

    case "prune": {
      const deleted = h.prune((args.older_than_days as number) ?? 90);
      return { status: "pruned", deleted_count: deleted };
    }

    case "stats":
      return h.stats();

    case "list_namespaces":
      return { namespaces: h.namespaces() };

    case "update": {
      const id = requireString(args, "id");
      const fields: Record<string, unknown> = {};
      for (const key of ["title", "content", "tags", "url", "scope", "priority", "namespace", "source"]) {
        if (args[key] !== undefined) {
          fields[key] = args[key];
        }
      }
      if (Object.keys(fields).length === 0) {
        throw new Error("At least one field besides id must be specified");
      }
      const result = await h.update(id, fields as UpdateInput);
      return { status: result.status, id: result.id };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function startServer(): Promise<void> {
  const server = new Server(
    { name: "hako", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleToolCall(name, args ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
