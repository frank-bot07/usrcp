// Re-export shim: the pairing protocol moved to usrcp-core. `renderPairingQr`
// (terminal QR rendering) is presentation and stays local in ./pair-qr.ts, so
// the `usrcp-local/pair` surface remains complete. See ./encryption.ts for the
// rationale; the core re-export is removed after Stage 3 dependent migration.
export * from "usrcp-core/pair";
export { renderPairingQr } from "./pair-qr.js";
