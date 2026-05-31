/**
 * MAIN-world fetch interceptor for claude.ai.
 *
 * Keep this function self-contained: Chrome serializes it when the service
 * worker calls scripting.executeScript({ func, args, world: "MAIN" }). That
 * single call binds the secret directly into the fetch-patch closure without
 * exposing an installer or secret-bearing handoff on window.
 */
export function installPageHook(secretHex: string): void {
  type CapturedTurn = {
    id: string;
    role: "assistant";
    content: string;
    conversation_id: string;
    timestamp: string;
  };

  const COMPLETION_PATTERN = /\/chat_conversations\/[^/]+\/completion/;
  const encoder = new TextEncoder();

  function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("invalid secret");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function bytesToHex(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
  }

  function canonical(turn: CapturedTurn): string {
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(turn).sort()) {
      ordered[key] = turn[key as keyof CapturedTurn];
    }
    return JSON.stringify(ordered);
  }

  async function signTurn(
    turn: CapturedTurn,
    secret: Uint8Array<ArrayBuffer>,
  ): Promise<{ ts: number; mac: string }> {
    const ts = Date.now();
    const key = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${canonical(turn)}|${ts}`),
    );
    return { ts, mac: bytesToHex(new Uint8Array(sig)) };
  }

  function extractConversationId(url: string): string {
    const match = /\/chat_conversations\/([^/]+)\/completion/.exec(url);
    return match ? match[1] : "unknown";
  }

  function parseSSEStream(rawStream: string, conversationId: string): CapturedTurn | null {
    let messageId = "";
    const textDeltas: string[] = [];
    let currentEventType = "";
    const pendingDataLines: string[] = [];

    function flushEvent(): void {
      if (!currentEventType && pendingDataLines.length === 0) return;
      const dataRaw = pendingDataLines.join("\n").trim();
      currentEventType = "";
      pendingDataLines.length = 0;
      if (!dataRaw || dataRaw === "[DONE]") return;

      let payload: any;
      try {
        payload = JSON.parse(dataRaw);
      } catch {
        return;
      }
      if (payload.type === "message_start") {
        messageId = payload.message?.id ?? "";
      } else if (
        payload.type === "content_block_delta" &&
        payload.delta?.type === "text_delta" &&
        typeof payload.delta.text === "string"
      ) {
        textDeltas.push(payload.delta.text);
      }
    }

    for (const rawLine of rawStream.split("\n")) {
      const line = rawLine.trimEnd();
      if (line === "") {
        flushEvent();
      } else if (line.startsWith("event: ")) {
        currentEventType = line.slice("event: ".length).trim();
      } else if (line.startsWith("data: ")) {
        pendingDataLines.push(line.slice("data: ".length));
      }
    }
    flushEvent();
    if (textDeltas.length === 0) return null;
    return {
      id: messageId || `usrcp-${Date.now()}`,
      role: "assistant",
      content: textDeltas.join(""),
      conversation_id: conversationId,
      timestamp: new Date().toISOString(),
    };
  }

  async function parseReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    conversationId: string,
  ): Promise<CapturedTurn | null> {
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return parseSSEStream(chunks.join(""), conversationId);
  }

  let secret: Uint8Array<ArrayBuffer>;
  try {
    secret = hexToBytes(secretHex);
  } catch {
    console.debug("[usrcp] page-hook: invalid secret; capture disabled");
    return;
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
    const res = await origFetch(...args);
    const url = typeof args[0] === "string"
      ? args[0]
      : args[0] instanceof URL
        ? args[0].href
        : (args[0] as Request).url;
    if (!COMPLETION_PATTERN.test(url) || !res.body) return res;

    const [pageStream, ourStream] = res.body.tee();
    parseReader(ourStream.getReader(), extractConversationId(url))
      .then(async (turn) => {
        if (!turn) return;
        const { ts, mac } = await signTurn(turn, secret);
        window.postMessage({ source: "usrcp", kind: "turn", turn, ts, mac }, "*");
      })
      .catch((err: unknown) => {
        console.debug("[usrcp] SSE parse / sign error:", err);
      });
    return new Response(pageStream, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
