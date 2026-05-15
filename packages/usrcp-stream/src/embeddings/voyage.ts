import type { EmbeddingProvider } from "./provider.js";

export interface VoyageEmbedderConfig {
  apiKey: string;
  model?: string;
  vendorConsent: true;
}

const MODEL_DIMS: Record<string, number> = {
  "voyage-3": 1024,
  "voyage-3-lite": 512,
  "voyage-3-large": 1024,
};

export class VoyageEmbedder implements EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  private apiKey: string;

  constructor(config: VoyageEmbedderConfig) {
    if (config.vendorConsent !== true) {
      throw new Error(
        "VoyageEmbedder requires explicit vendorConsent=true. " +
          "Plaintext message content will be sent to Voyage AI for embedding. " +
          "Re-run `usrcp-stream init --embedding-provider voyage` and confirm the prompt to enable."
      );
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "voyage-3";
    this.dims = MODEL_DIMS[this.model] ?? 1024;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: [text] }),
    });
    if (!res.ok) {
      throw new Error(`Voyage embed failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
      data: { embedding: number[] }[];
    };
    return new Float32Array(body.data[0].embedding);
  }
}
