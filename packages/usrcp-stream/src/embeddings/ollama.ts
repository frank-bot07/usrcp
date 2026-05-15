import type { EmbeddingProvider } from "./provider.js";

export interface OllamaConfig {
  host?: string;
  model?: string;
}

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "nomic-embed-text";

const KNOWN_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
};

export class OllamaEmbedder implements EmbeddingProvider {
  readonly host: string;
  readonly model: string;
  readonly dims: number;

  constructor(config: OllamaConfig = {}, overrideDims?: number) {
    this.host = config.host ?? DEFAULT_HOST;
    this.model = config.model ?? DEFAULT_MODEL;
    this.dims = overrideDims ?? KNOWN_DIMS[this.model] ?? 768;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch(`${this.host}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) {
      throw new Error(
        `Ollama embed failed (${res.status} ${res.statusText}). ` +
          `Is the model '${this.model}' pulled? Try: ollama pull ${this.model}`
      );
    }
    const body = (await res.json()) as { embedding?: number[] };
    if (!body.embedding) {
      throw new Error(
        `Ollama returned no embedding. Response keys: ${Object.keys(body).join(", ")}`
      );
    }
    return new Float32Array(body.embedding);
  }
}

export async function pingOllama(host = DEFAULT_HOST): Promise<boolean> {
  try {
    const res = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}
