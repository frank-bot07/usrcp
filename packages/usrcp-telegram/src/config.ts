import { createAdapterConfig } from "usrcp-adapter-kit";

export interface TelegramConfig {
  telegram_bot_token: string;
  anthropic_api_key: string;
  /** Stringified Telegram chat IDs. Groups have negative IDs; stringified for storage parity. */
  allowlisted_chats: string[];
  /** Stringified Telegram user ID of the owner. Only messages from this user are captured. */
  user_id: string;
}

// Encrypted-at-rest config store — see usrcp-adapter-kit. Telegram is a
// bot adapter: two secrets, no poll cursor.
const store = createAdapterConfig<TelegramConfig>({
  adapterName: "telegram",
  filename: "telegram-config.json",
  fields: [
    { name: "telegram_bot_token", kind: "secret" },
    { name: "anthropic_api_key", kind: "secret" },
    { name: "allowlisted_chats", kind: "requiredNonEmptyArray" },
    { name: "user_id", kind: "required" },
  ],
});

export const getConfigPath = store.getConfigPath;
export const readPartialConfig = store.readPartialConfig;
export const readPartialDecryptedConfig = store.readPartialDecryptedConfig;
export const writeTelegramConfig = store.writeConfig;
export const preflightConfig = store.preflightConfig;
export const loadConfig = store.loadConfig;
export const reencryptConfigUnderNewKey = store.reencryptConfigUnderNewKey;
