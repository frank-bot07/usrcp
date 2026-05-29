/**
 * usrcp-adapter-kit — shared building blocks for USRCP capture adapters.
 *
 * Today this is the encrypted-at-rest config store every adapter used to
 * copy-paste. It is the single deep-importer of `usrcp-local`'s internals
 * (the encryption primitives); adapters depend on this kit instead of
 * reaching into `usrcp-local/dist/*` themselves.
 */
export {
  createAdapterConfig,
  type AdapterConfigSpec,
  type AdapterConfigStore,
  type FieldSpec,
  type FieldKind,
} from "./config-store.js";
