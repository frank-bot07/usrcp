import { createAdapterConfig } from "usrcp-adapter-kit";

export interface DiscordConfig {
  discord_bot_token: string;
  anthropic_api_key: string;
  allowlisted_channels: string[];
  user_id: string;
}

// Encrypted-at-rest config store — see usrcp-adapter-kit. Discord is a
// bot adapter: two secrets, no poll cursor.
const store = createAdapterConfig<DiscordConfig>({
  adapterName: "discord",
  filename: "discord-config.json",
  fields: [
    { name: "discord_bot_token", kind: "secret" },
    { name: "anthropic_api_key", kind: "secret" },
    { name: "allowlisted_channels", kind: "requiredNonEmptyArray" },
    { name: "user_id", kind: "required" },
  ],
});

export const getConfigPath = store.getConfigPath;
export const readPartialConfig = store.readPartialConfig;
export const readPartialDecryptedConfig = store.readPartialDecryptedConfig;
export const writeDiscordConfig = store.writeConfig;
export const preflightConfig = store.preflightConfig;
export const loadConfig = store.loadConfig;
export const reencryptConfigUnderNewKey = store.reencryptConfigUnderNewKey;
