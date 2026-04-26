/**
 * Thin Anthropic SDK wrapper — two call sites:
 *   - summarize(text): short one-liner summary for captured messages
 *   - reply(system, user): full conversational reply for @-mentions / DMs
 *
 * Both calls pin explicit model IDs so upstream default changes don't
 * shift behavior underneath us.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface LlmClient {
  summarize(content: string): Promise<string>;
  reply(systemPrompt: string, userMessage: string): Promise<string>;
}

export interface AnthropicLlmOptions {
  apiKey: string;
  summarizeModel?: string;
  replyModel?: string;
}

// Haiku is plenty for single-sentence summaries; Sonnet for user-facing replies.
const DEFAULT_SUMMARIZE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_REPLY_MODEL = "claude-sonnet-4-6";

export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  private summarizeModel: string;
  private replyModel: string;

  constructor(opts: AnthropicLlmOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.summarizeModel = opts.summarizeModel ?? DEFAULT_SUMMARIZE_MODEL;
    this.replyModel = opts.replyModel ?? DEFAULT_REPLY_MODEL;
  }

  async summarize(content: string): Promise<string> {
    const res = await this.client.messages.create({
      model: this.summarizeModel,
      max_tokens: 150,
      system:
        "Summarize the user's message in one sentence. Capture intent and any concrete entities (names, projects, topics). No preamble, no quoting.",
      messages: [{ role: "user", content }],
    });
    return extractText(res).trim();
  }

  async reply(systemPrompt: string, userMessage: string): Promise<string> {
    const res = await this.client.messages.create({
      model: this.replyModel,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    return extractText(res).trim();
  }
}

function extractText(res: { content: Array<{ type: string; text?: string }> }): string {
  const parts: string[] = [];
  for (const block of res.content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}
