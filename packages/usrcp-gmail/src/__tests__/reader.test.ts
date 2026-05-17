import { describe, it, expect } from "vitest";
import { normaliseMessage } from "../reader.js";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

// 2026-05-17T10:00:00Z in unix-ms.
const SENT_AT_ISO = "2026-05-17T10:00:00.000Z";
const SENT_AT_MS = new Date(SENT_AT_ISO).getTime();

function mkRaw(overrides: Record<string, unknown> = {}): any {
  return {
    id: "msg-123",
    threadId: "thread-abc",
    snippet: "Thanks - I'll review the deck...",
    internalDate: String(SENT_AT_MS),
    labelIds: ["SENT"],
    payload: {
      headers: [
        { name: "From", value: "alice@example.com" },
        { name: "To", value: "bob@example.com" },
        { name: "Cc", value: "carol@example.com" },
        { name: "Subject", value: "Re: project update" },
        { name: "Date", value: "Sat, 17 May 2026 10:00:00 +0000" },
      ],
      mimeType: "text/plain",
      body: { data: b64("Thanks - I'll review the deck tonight and send notes.") },
    },
    ...overrides,
  };
}

describe("normaliseMessage", () => {
  it("flattens a plain-text sent message", () => {
    const out = normaliseMessage(mkRaw());
    expect(out).not.toBeNull();
    expect(out!.type).toBe("email_sent");
    expect(out!.id).toBe("msg-123");
    expect(out!.thread_id).toBe("thread-abc");
    expect(out!.subject).toBe("Re: project update");
    expect(out!.body).toContain("review the deck");
    expect(out!.from).toBe("alice@example.com");
    expect(out!.to).toBe("bob@example.com");
    expect(out!.cc).toBe("carol@example.com");
    expect(out!.bcc).toBeNull();
    expect(out!.label_ids).toEqual(["SENT"]);
    expect(out!.sent_at).toBe(SENT_AT_ISO);
  });

  it("walks a multipart message and prefers text/plain", () => {
    const raw = mkRaw({
      payload: {
        headers: [
          { name: "From", value: "alice@example.com" },
          { name: "To", value: "bob@example.com" },
          { name: "Subject", value: "Multipart" },
        ],
        mimeType: "multipart/alternative",
        parts: [
          {
            mimeType: "text/plain",
            body: { data: b64("plain body content") },
          },
          {
            mimeType: "text/html",
            body: { data: b64("<p>HTML body content</p>") },
          },
        ],
      },
    });
    const out = normaliseMessage(raw);
    expect(out).not.toBeNull();
    expect(out!.body).toBe("plain body content");
  });

  it("falls back to text/html when text/plain part is empty/whitespace (Gmail decoy)", () => {
    // Some clients emit a multipart/alternative with an empty text/plain
    // and the real content in text/html. Without this fallback the body
    // would be discarded and the message could be filtered as
    // no_subject_no_body.
    const raw = mkRaw({
      payload: {
        headers: [
          { name: "Subject", value: "" }, // also no subject so we exercise the worst case
          { name: "From", value: "alice@example.com" },
          { name: "To", value: "bob@example.com" },
        ],
        mimeType: "multipart/alternative",
        parts: [
          {
            mimeType: "text/plain",
            body: { data: b64("   \n\t  \n") },
          },
          {
            mimeType: "text/html",
            body: { data: b64("<p>Real content here</p>") },
          },
        ],
      },
    });
    const out = normaliseMessage(raw);
    expect(out).not.toBeNull();
    expect(out!.body).toBe("Real content here");
  });

  it("falls back to stripped HTML when no text/plain part exists", () => {
    const raw = mkRaw({
      payload: {
        headers: [
          { name: "From", value: "alice@example.com" },
          { name: "To", value: "bob@example.com" },
          { name: "Subject", value: "HTML only" },
        ],
        mimeType: "text/html",
        body: { data: b64("<html><body><p>Hi <b>Bob</b>!</p></body></html>") },
      },
    });
    const out = normaliseMessage(raw);
    expect(out).not.toBeNull();
    expect(out!.body).toBe("Hi Bob !");
  });

  it("skips text/plain attachments and uses the real body part instead", () => {
    // multipart/mixed wrapping a multipart/alternative body PLUS a
    // text/plain attachment. The attachment must NOT win - the body
    // text is the one captured.
    const raw = mkRaw({
      payload: {
        headers: [
          { name: "Subject", value: "With an attachment" },
        ],
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/plain",
                body: { data: b64("Hi Bob, see attached.") },
              },
              {
                mimeType: "text/html",
                body: { data: b64("<p>Hi Bob, see attached.</p>") },
              },
            ],
          },
          {
            mimeType: "text/plain",
            filename: "notes.txt",
            body: { data: b64("This is a 500-line text attachment that shouldn't become the body.") },
          },
        ],
      },
    });
    const out = normaliseMessage(raw);
    expect(out).not.toBeNull();
    expect(out!.body).toBe("Hi Bob, see attached.");
  });

  it("skips parts that store body content via attachmentId (no inline data)", () => {
    const raw = mkRaw({
      payload: {
        headers: [
          { name: "Subject", value: "Attachment-by-id" },
        ],
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "text/plain",
            body: { data: b64("Real body content.") },
          },
          {
            mimeType: "text/plain",
            body: { attachmentId: "ATT_123", size: 4096 }, // no data
          },
        ],
      },
    });
    const out = normaliseMessage(raw);
    expect(out).not.toBeNull();
    expect(out!.body).toBe("Real body content.");
  });

  it("strips <script> and <style> tags before extracting HTML text", () => {
    const raw = mkRaw({
      payload: {
        headers: [
          { name: "Subject", value: "Bad HTML" },
        ],
        mimeType: "text/html",
        body: { data: b64("<style>.x{color:red}</style><script>alert(1)</script><p>visible</p>") },
      },
    });
    const out = normaliseMessage(raw);
    expect(out).not.toBeNull();
    expect(out!.body).toBe("visible");
  });

  it("returns null when id is missing", () => {
    const out = normaliseMessage(mkRaw({ id: undefined }));
    expect(out).toBeNull();
  });

  it("returns null when internalDate is missing or non-numeric", () => {
    expect(normaliseMessage(mkRaw({ internalDate: undefined }))).toBeNull();
    expect(normaliseMessage(mkRaw({ internalDate: "not-a-number" }))).toBeNull();
  });

  it("falls back to message id as thread_id when threadId is missing", () => {
    const out = normaliseMessage(mkRaw({ threadId: undefined }));
    expect(out).not.toBeNull();
    expect(out!.thread_id).toBe("msg-123");
  });

  it("handles missing optional headers gracefully", () => {
    const raw = mkRaw({
      payload: {
        headers: [
          { name: "From", value: "alice@example.com" },
          // no To, no Subject, no Cc/Bcc/Date
        ],
        mimeType: "text/plain",
        body: { data: b64("body") },
      },
    });
    const out = normaliseMessage(raw);
    expect(out).not.toBeNull();
    expect(out!.subject).toBe("");
    expect(out!.to).toBe("");
    expect(out!.cc).toBeNull();
    expect(out!.bcc).toBeNull();
    expect(out!.date_header).toBeNull();
  });
});
