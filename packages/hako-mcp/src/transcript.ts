interface QAChunk {
  readonly content: string;
  readonly tags: string;
}

export type TranscriptFormat = "auto" | "claude" | "codex";

interface Block {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export function parseTranscript(text: string, format: TranscriptFormat = "auto"): QAChunk[] {
  const formats: readonly Exclude<TranscriptFormat, "auto">[] =
    format === "auto" ? ["claude", "codex"] : [format];

  for (const currentFormat of formats) {
    const blocks = currentFormat === "claude"
      ? parseClaudeJsonl(text)
      : parseCodexJsonl(text);
    const chunks = blocksToChunks(blocks);
    if (chunks.length > 0) return chunks;
  }

  return [];
}

function blocksToChunks(blocks: readonly Block[]): QAChunk[] {
  if (blocks.length === 0) return [];

  const chunks: QAChunk[] = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];
    if (block.role === "user") {
      const question = block.text;
      const answerParts: string[] = [];

      while (i + 1 < blocks.length && blocks[i + 1].role === "assistant") {
        answerParts.push(blocks[i + 1].text);
        i++;
      }

      const answer = answerParts.join("\n\n");
      if (question || answer) {
        const content = formatQA(question, answer);
        if (content.length > 50) {
          chunks.push({ content, tags: "" });
        }
      }
    }
    i++;
  }

  return chunks;
}

function parseClaudeJsonl(text: string): Block[] {
  const blocks: Block[] = [];

  for (const rec of parseJsonlRecords(text)) {
    const recType = rec.type as string | undefined;
    if (recType !== "user" && recType !== "assistant") continue;

    const message = (rec.message ?? {}) as Record<string, unknown>;
    const content = message.content ?? "";

    if (recType === "user") {
      const userText = extractUserText(content);
      if (userText) {
        blocks.push({ role: "user", text: userText });
      }
    } else {
      const assistantText = extractAssistantText(content);
      if (assistantText) {
        blocks.push({ role: "assistant", text: assistantText });
      }
    }
  }

  return blocks;
}

function parseCodexJsonl(text: string): Block[] {
  const records = parseJsonlRecords(text);
  const hasTurnContext = records.some((rec) => rec.type === "turn_context");
  const blocks: Block[] = [];
  let seenTurnContext = false;

  for (const rec of records) {
    if (rec.type === "turn_context") {
      seenTurnContext = true;
      continue;
    }

    if (hasTurnContext && !seenTurnContext) continue;
    if (rec.type !== "response_item") continue;

    const payload = (rec.payload ?? {}) as Record<string, unknown>;
    if (payload.type !== "message") continue;

    const role = payload.role as string | undefined;
    if (role !== "user" && role !== "assistant") continue;

    const content = payload.content ?? "";
    const text = extractCodexText(content, role).trim();
    if (text) {
      blocks.push({ role, text });
    }
  }

  return blocks;
}

function parseJsonlRecords(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const rec = JSON.parse(trimmed);
      if (typeof rec === "object" && rec !== null) {
        records.push(rec as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }

  return records;
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content.trim();

  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        texts.push(block);
      } else if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text"
      ) {
        texts.push(((block as Record<string, unknown>).text as string) ?? "");
      }
    }
    return texts.join("\n").trim();
  }

  return "";
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content.trim();

  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text"
      ) {
        const text = ((block as Record<string, unknown>).text as string ?? "").trim();
        if (text) texts.push(text);
      }
    }
    return texts.join("\n\n");
  }

  return "";
}

function extractCodexText(content: unknown, role: "user" | "assistant"): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const wantedType = role === "user" ? "input_text" : "output_text";
  const texts: string[] = [];

  for (const block of content) {
    if (typeof block === "string") {
      texts.push(block);
    } else if (typeof block === "object" && block !== null) {
      const rec = block as Record<string, unknown>;
      if (rec.type === wantedType || rec.type === "text") {
        texts.push((rec.text as string) ?? "");
      }
    }
  }

  return texts.join(role === "assistant" ? "\n\n" : "\n").trim();
}

function formatQA(question: string, answer: string): string {
  const parts: string[] = [];
  if (question) parts.push(`Q: ${question}`);
  if (answer) parts.push(`A: ${answer}`);
  return parts.join("\n");
}
