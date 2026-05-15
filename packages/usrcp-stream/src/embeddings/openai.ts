import type { EmbeddingProvider } from "./provider.js";

export interface OpenAIEmbedderConfig {
  apiKey: string;
  model?: string;
  // Must be a literal `true`. Set only via the `usrcp-stream init
  // --embedding-provider openai` flow after the user clears the
  // plaintext-leaves-machine confirmation prompt.
  vendorConsent: true;
}

const MODEL_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export class OpenAIEmbedder implements EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  private apiKey: string;

  constructor(config: OpenAIEmbedderConfig) {
    if (config.vendorConsent !== true) {
      throw new Error(
        "OpenAIEmbedder requires explicit vendorConsent=true. " +
          "Plaintext message content will be sent to OpenAI for embedding. " +
          "Re-run `usrcp-stream init --embedding-provider openai` and confirm the prompt to enable."
      );
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "text-embedding-3-small";
    this.dims = MODEL_DIMS[this.model] ?? 1536;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embed failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
      data: { embedding: number[] }[];
    };
    return new Float32Array(body.data[0].embedding);
  }
}
