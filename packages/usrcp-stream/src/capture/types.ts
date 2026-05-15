import { z } from "zod";

// Length constants mirror usrcp-local/src/server.ts:9-15 to keep schema
// limits consistent across the two packages.
export const MAX_STRING_SHORT = 100;
export const MAX_STRING_MEDIUM = 300;
export const MAX_STRING_LONG = 500;
export const MAX_CONTENT_BYTES = 64 * 1024;
export const MAX_ENTITY_REFS = 100;

export const SideSchema = z.enum(["inbound", "outbound", "system"]);
export type Side = z.infer<typeof SideSchema>;

// Known surfaces are a literal preference, but capture should not refuse
// a freshly-added adapter. Validate length, not enum membership.
export const SurfaceSchema = z.string().min(1).max(64);
export type Surface = string;

export const ChannelRefSchema = z.record(z.string(), z.unknown());
export type ChannelRef = Record<string, unknown>;

export const AuthorRefSchema = z.object({
  id: z.string().min(1).max(MAX_STRING_MEDIUM),
  displayName: z.string().max(MAX_STRING_MEDIUM).optional(),
});
export type AuthorRef = z.infer<typeof AuthorRefSchema>;

export const ContentKindSchema = z.enum([
  "text",
  "code",
  "image-caption",
  "tool-call",
  "tool-result",
]);
export type ContentKind = z.infer<typeof ContentKindSchema>;

export const CaptureEventSchema = z.object({
  surface: SurfaceSchema,
  channel_ref: ChannelRefSchema,
  side: SideSchema,
  author_ref: AuthorRefSchema,
  content: z.string().min(1).max(MAX_CONTENT_BYTES),
  content_kind: ContentKindSchema,
  ts_ms: z.number().int().nonnegative(),
  entity_refs: z
    .array(z.string().max(MAX_STRING_MEDIUM))
    .max(MAX_ENTITY_REFS)
    .optional(),
});
export type CaptureEvent = z.infer<typeof CaptureEventSchema>;

export interface CapturedEvent {
  event_uuid: string;
  thread_id: string | null;
  ingested_at: number;
}
