import { createAdapterConfig } from "usrcp-adapter-kit";

export interface SlackConfig {
  slack_bot_token: string;        // xoxb-...
  slack_app_token: string;        // xapp-...
  anthropic_api_key: string;
  allowlisted_channels: string[]; // C... or D... IDs
  user_id: string;                // U... - the workspace user ID (not the bot's)
}

// Encrypted-at-rest config store — see usrcp-adapter-kit. Slack is a bot
// adapter: three secrets, no poll cursor.
const store = createAdapterConfig<SlackConfig>({
  adapterName: "slack",
  filename: "slack-config.json",
  fields: [
    { name: "slack_bot_token", kind: "secret" },
    { name: "slack_app_token", kind: "secret" },
    { name: "anthropic_api_key", kind: "secret" },
    { name: "allowlisted_channels", kind: "requiredNonEmptyArray" },
    { name: "user_id", kind: "required" },
  ],
});

export const getConfigPath = store.getConfigPath;
export const readPartialConfig = store.readPartialConfig;
export const readPartialDecryptedConfig = store.readPartialDecryptedConfig;
export const writeSlackConfig = store.writeConfig;
export const preflightConfig = store.preflightConfig;
export const loadConfig = store.loadConfig;
export const reencryptConfigUnderNewKey = store.reencryptConfigUnderNewKey;
