// Tunables for stitcher, presence, and prewarm. Defaults match the build
// prompt §7 / §8. At runtime the CLI's init flow reads overrides from
// `${userDir}/stream-config.toml` (encrypted) and merges over these.

export interface StitchConfig {
  entity_window_ms: number;
  topic_threshold: number;
  topic_window_ms: number;
  same_channel_window_ms: number;
  w_entity: number;
  w_topic: number;
  w_recency: number;
  recency_tau_ms: number;
  link_threshold: number;
}

export interface PresenceConfig {
  active_window_ms: number;
}

export interface PrewarmConfig {
  window_min: number;
  max_tokens: number;
  decay_ms: number;
}

export const DEFAULT_STITCH: StitchConfig = {
  entity_window_ms: 24 * 60 * 60 * 1000,
  topic_threshold: 0.78,
  topic_window_ms: 6 * 60 * 60 * 1000,
  same_channel_window_ms: 30 * 60 * 1000,
  w_entity: 0.5,
  w_topic: 0.35,
  w_recency: 0.15,
  recency_tau_ms: 2 * 60 * 60 * 1000,
  link_threshold: 0.55,
};

export const DEFAULT_PRESENCE: PresenceConfig = {
  active_window_ms: 10 * 60 * 1000,
};

export const DEFAULT_PREWARM: PrewarmConfig = {
  window_min: 30,
  max_tokens: 1500,
  decay_ms: 5 * 60 * 1000,
};
