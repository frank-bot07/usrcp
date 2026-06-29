// Re-export shim + adapter-rotation seam.
//
// The ledger moved to usrcp-core. usrcp-core's ledger is deliberately unaware
// of the adapter system (registry, per-adapter config encryption). This barrel
// registers the adapter-rotation recovery hook so that opening a Ledger in an
// adapter-aware context — usrcp-local and everything that imports its ledger —
// resumes an interrupted adapter-config rotation exactly as it did before the
// core extraction. Importing this module runs the registration as a side effect
// before any Ledger is constructed.
//
// Removed/relocated when dependents migrate to usrcp-core directly (Stage 3);
// at that point the hook registration moves with the adapter-aware consumers.
import { setAdapterRotationResumeHook } from "usrcp-core/ledger";
import { resumeAdapterRotationIfPending } from "../rotate-adapter-configs.js";

setAdapterRotationResumeHook(resumeAdapterRotationIfPending);

export * from "usrcp-core/ledger";
