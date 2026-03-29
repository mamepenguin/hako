import { getEmbeddingConfig } from "./config.js";

export const EMBEDDING_DIM = 256;

type Pipeline = Awaited<
  ReturnType<typeof import("@huggingface/transformers").pipeline>
>;

let _pipeline: Pipeline | null = null;

async function getPipeline(): Promise<Pipeline> {
  if (_pipeline === null) {
    const { pipeline } = await import("@huggingface/transformers");
    const cfg = getEmbeddingConfig();
    _pipeline = await pipeline("feature-extraction", cfg.model, {
      dtype: "q8",
    });
  }
  return _pipeline;
}

export function makeEmbeddingInput(
  title: string,
  content: string | null,
): string {
  const cfg = getEmbeddingConfig();
  let text = title;
  if (content) {
    text += " " + content.slice(0, cfg.max_content_chars);
  }
  return text;
}

export async function embed(text: string): Promise<number[]> {
  const pipe = await getPipeline();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array).slice(0, EMBEDDING_DIM);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  const results: number[][] = [];
  for (const text of texts) {
    const output = await pipe(text, { pooling: "mean", normalize: true });
    results.push(
      Array.from(output.data as Float32Array).slice(0, EMBEDDING_DIM),
    );
  }
  return results;
}

export function serializeVec(vec: number[]): Float32Array {
  return new Float32Array(vec);
}

export function deserializeVec(data: Buffer | Float32Array): number[] {
  if (data instanceof Float32Array) {
    return Array.from(data);
  }
  const floats = new Float32Array(
    data.buffer,
    data.byteOffset,
    data.byteLength / 4,
  );
  return Array.from(floats);
}

/** Reset pipeline for testing. */
export function _resetPipeline(): void {
  _pipeline = null;
}
