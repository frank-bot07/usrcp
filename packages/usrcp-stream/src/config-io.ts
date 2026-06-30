import * as fs from "node:fs";
import * as path from "node:path";
import * as TOML from "@iarna/toml";
import {
  encrypt,
  decrypt,
  isEncrypted,
  deriveDomainEncryptionKey,
  safeWriteFile,
} from "usrcp-core/encryption";
import { OllamaEmbedder } from "./embeddings/ollama.js";
import { OpenAIEmbedder } from "./embeddings/openai.js";
import { VoyageEmbedder } from "./embeddings/voyage.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";

export type EmbeddingProviderName = "ollama" | "openai" | "voyage";

export interface StreamConfig {
  embedding: {
    provider: EmbeddingProviderName;
    model?: string;
    host?: string;
    vendor_consent?: boolean;
  };
  // The API key for vendor providers is persisted INSIDE the encrypted
  // config file (the whole file goes through encrypt() with HKDF domain
  // stream-config). Never on the command line, never in environment.
  _api_key?: string;
}

export function configPath(userDir: string): string {
  return path.join(userDir, "stream-config.toml");
}

export function loadConfig(
  masterKey: Buffer,
  userDir: string
): StreamConfig | null {
  const p = configPath(userDir);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf-8").trim();
  if (raw.length === 0) return null;
  const key = deriveDomainEncryptionKey(masterKey, "stream-config");
  const plaintext = isEncrypted(raw) ? decrypt(raw, key) : raw;
  return TOML.parse(plaintext) as unknown as StreamConfig;
}

export function saveConfig(
  masterKey: Buffer,
  userDir: string,
  config: StreamConfig
): void {
  fs.mkdirSync(userDir, { recursive: true });
  const tomlText = TOML.stringify(config as unknown as TOML.JsonMap);
  const key = deriveDomainEncryptionKey(masterKey, "stream-config");
  const ciphertext = encrypt(tomlText, key);
  safeWriteFile(configPath(userDir), Buffer.from(ciphertext, "utf-8"), 0o600);
}

// Construct an embedding provider from saved config. Returns null when
// the config is missing, the chosen provider isn't reachable, or vendor
// consent is required-but-absent. Synchronous: we don't probe Ollama at
// construction time because a) the sync registration path can't await,
// and b) the first embed() call surfaces a precise error if the daemon
// is down. Trust the config; fail at use, not at registration.
export function embedderFromConfig(
  config: StreamConfig | null
): EmbeddingProvider | null {
  if (!config) return null;
  const { provider, model, host, vendor_consent } = config.embedding;

  switch (provider) {
    case "ollama":
      return new OllamaEmbedder({
        host: host ?? "http://localhost:11434",
        model,
      });
    case "openai":
      if (vendor_consent !== true || !config._api_key) return null;
      return new OpenAIEmbedder({
        apiKey: config._api_key,
        model,
        vendorConsent: true,
      });
    case "voyage":
      if (vendor_consent !== true || !config._api_key) return null;
      return new VoyageEmbedder({
        apiKey: config._api_key,
        model,
        vendorConsent: true,
      });
  }
}

// Convenience: load + construct in one call.
export function loadEmbedderFromUserDir(
  masterKey: Buffer,
  userDir: string
): EmbeddingProvider | null {
  let config: StreamConfig | null = null;
  try {
    config = loadConfig(masterKey, userDir);
  } catch {
    return null;
  }
  return embedderFromConfig(config);
}
