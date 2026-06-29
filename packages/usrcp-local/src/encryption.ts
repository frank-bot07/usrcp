// Re-export shim: the encryption primitives moved to usrcp-core. This stub
// preserves the `usrcp-local/encryption` subpath (and the internal
// `./encryption.js` imports) during the core extraction. Dependents will be
// migrated to import from `usrcp-core/encryption` directly (Stage 3), after
// which this shim is removed.
export * from "usrcp-core/encryption";
