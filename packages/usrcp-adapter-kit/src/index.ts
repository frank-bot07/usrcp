/**
 * usrcp-adapter-kit — shared building blocks for USRCP capture adapters.
 *
 * Today this is the encrypted-at-rest config store every adapter used to
 * copy-paste (built on `usrcp-core`'s encryption primitives), plus the shared
 * localhost OAuth flow used by the Google adapters (`usrcp-adapter-kit/google-oauth`).
 * Adapters depend on this kit instead of reaching into protocol internals.
 */
export {
  createAdapterConfig,
  type AdapterConfigSpec,
  type AdapterConfigStore,
  type FieldSpec,
  type FieldKind,
} from "./config-store.js";
