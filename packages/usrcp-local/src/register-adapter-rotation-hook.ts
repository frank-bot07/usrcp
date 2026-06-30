// Registers the adapter-rotation recovery hook on usrcp-core's ledger.
//
// usrcp-core's ledger is deliberately unaware of the adapter system. This
// module wires the recovery sweep (resumeAdapterRotationIfPending) into the
// ledger's open-time hook so that, in usrcp-local — the package that actually
// manages adapter configs — opening a Ledger resumes an interrupted
// adapter-config rotation exactly as before the core extraction.
//
// Import this for its side effect at every usrcp-local entry point that opens
// a Ledger (the CLI in index.ts and the MCP server in server.ts), before any
// Ledger is constructed.
import { setAdapterRotationResumeHook } from "usrcp-core/ledger";
import { resumeAdapterRotationIfPending } from "./rotate-adapter-configs.js";

setAdapterRotationResumeHook(resumeAdapterRotationIfPending);
