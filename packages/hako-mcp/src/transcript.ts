interface QAChunk {
  readonly content: string;
  readonly tags: string;
}

interface Block {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export function parseTranscript(text: string): QAChunk[] {
  const blocks = parseJsonl(text);
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

function parseJsonl(text: string): Block[] {
  const blocks: Block[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }

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

function formatQA(question: string, answer: string): string {
  const parts: string[] = [];
  if (question) parts.push(`Q: ${question}`);
  if (answer) parts.push(`A: ${answer}`);
  return parts.join("\n");
}
