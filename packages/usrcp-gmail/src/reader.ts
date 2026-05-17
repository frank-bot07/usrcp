/**
 * Gmail API client wrapper.
 *
 * Mints short-lived access tokens from the long-lived refresh token
 * on every poll (google-auth-library caches the access token
 * internally while still valid), then calls users.messages.list with
 * a `q=from:me after:<unix-seconds>` filter to pull only SENT
 * messages newer than the cursor. messages.list returns ID stubs;
 * each one is then fetched at format=full to get headers + body.
 *
 * Returns flattened GmailActivity records so capture.ts is testable
 * without mocking the SDK.
 */

import { OAuth2Client } from "google-auth-library";
import { gmail, type gmail_v1 } from "@googleapis/gmail";
import type { GmailActivity } from "./capture.js";

export interface OAuthSecrets {
  oauth_client_id: string;
  oauth_client_secret: string;
  refresh_token: string;
}

export function makeOAuthClient(secrets: OAuthSecrets): OAuth2Client {
  const client = new OAuth2Client({
    clientId: secrets.oauth_client_id,
    clientSecret: secrets.oauth_client_secret,
  });
  client.setCredentials({ refresh_token: secrets.refresh_token });
  return client;
}

/**
 * Validate credentials by minting a token + calling users.getProfile.
 * Used by the wizard to fail fast before persisting bad config.
 */
export async function validateCredentials(
  secrets: OAuthSecrets
): Promise<{ ok: true; email: string; total_messages: number } | { ok: false; error: string }> {
  try {
    const auth = makeOAuthClient(secrets);
    const api = gmail({ version: "v1", auth });
    const profile = await api.users.getProfile({ userId: "me" });
    return {
      ok: true,
      email: profile.data.emailAddress ?? "(unknown)",
      total_messages: profile.data.messagesTotal ?? 0,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface FetchSentMessagesOpts {
  /** ISO timestamp - lower bound. Returned messages were sent after this. */
  sentAfter: Date;
  /** Cap on results per tick (defaults to 100). Gmail's per-page max is 500. */
  pageSize?: number;
}

/**
 * Fetch SENT messages newer than the cursor. Two-phase pull because
 * Gmail's list endpoint returns ID stubs only:
 *   1. users.messages.list { q: 'from:me after:<unix>' } -> [ids]
 *   2. messages.get for each id at format=full -> headers + body.
 *
 * Skips messages in DRAFT / TRASH / SPAM. The user-facing "I sent
 * this" intent only fires for messages that left the outbox.
 */
export async function fetchSentMessages(
  api: gmail_v1.Gmail,
  opts: FetchSentMessagesOpts
): Promise<GmailActivity[]> {
  const out: GmailActivity[] = [];
  const pageSize = opts.pageSize ?? 100;
  const afterSeconds = Math.floor(opts.sentAfter.getTime() / 1000);
  // Gmail's search query syntax. `in:sent` is more reliable than
  // `from:me` (the latter falls through to the broader From-header
  // alias system); combined with the negative label filters to skip
  // drafts and spam.
  const q = `in:sent after:${afterSeconds} -in:drafts -in:trash -in:spam`;

  let pageToken: string | undefined;
  const ids: string[] = [];
  do {
    const res = await api.users.messages.list({
      userId: "me",
      q,
      maxResults: pageSize,
      pageToken,
    });
    for (const m of res.data.messages ?? []) {
      if (m.id) ids.push(m.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  // Fetch each message in full. Sequential to respect Gmail's
  // per-user rate budget; for the typical "polled every 10 min"
  // cadence we expect a few messages per tick.
  for (const id of ids) {
    const res = await api.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
    const activity = normaliseMessage(res.data);
    if (activity) out.push(activity);
  }

  return out;
}

/**
 * Flatten a Gmail message into the capture-ready shape. Returns null
 * for messages we should skip (missing id, no headers, etc.).
 *
 * Body extraction prefers `text/plain` over `text/html`. If only
 * HTML is present we strip tags with a minimal regex; this is
 * lossy but adequate for "what did I write" recall.
 */
export function normaliseMessage(msg: gmail_v1.Schema$Message): GmailActivity | null {
  if (!msg.id || !msg.payload) return null;

  const headers = new Map<string, string>();
  for (const h of msg.payload.headers ?? []) {
    if (h.name && h.value) headers.set(h.name.toLowerCase(), h.value);
  }
  const subject = headers.get("subject") ?? "";
  const to = headers.get("to") ?? "";
  const cc = headers.get("cc") ?? "";
  const bcc = headers.get("bcc") ?? "";
  const from = headers.get("from") ?? "";
  const dateHeader = headers.get("date") ?? null;

  const body = extractBody(msg.payload);

  // Gmail's internalDate is the unix-ms timestamp Gmail received the
  // message. For sent items this is "when the send completed" and is
  // the most reliable cursor anchor.
  const internalDateMs = msg.internalDate ? Number(msg.internalDate) : null;
  if (!Number.isFinite(internalDateMs)) return null;
  const sentAt = new Date(internalDateMs as number).toISOString();

  return {
    type: "email_sent",
    id: msg.id,
    thread_id: msg.threadId ?? msg.id,
    subject,
    body,
    snippet: msg.snippet ?? "",
    from,
    to,
    cc: cc || null,
    bcc: bcc || null,
    date_header: dateHeader,
    label_ids: msg.labelIds ?? [],
    sent_at: sentAt,
  };
}

function extractBody(payload: gmail_v1.Schema$MessagePart): string {
  // Walk the MIME tree depth-first; prefer text/plain. If we only find
  // text/html, strip tags as a fallback.
  const parts: gmail_v1.Schema$MessagePart[] = [payload];
  let plain: string | null = null;
  let html: string | null = null;
  while (parts.length > 0) {
    const p = parts.shift()!;
    if (p.parts && p.parts.length > 0) {
      parts.push(...p.parts);
      continue;
    }
    if (!p.body?.data) continue;
    const decoded = Buffer.from(p.body.data, "base64url").toString("utf8");
    if (p.mimeType === "text/plain" && plain === null) {
      plain = decoded;
    } else if (p.mimeType === "text/html" && html === null) {
      html = decoded;
    }
  }
  if (plain !== null) return plain;
  if (html !== null) return stripTags(html);
  return "";
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
