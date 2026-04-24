// Barrel: imports the Ledger class from core, then augments its prototype
// with per-concern methods via side-effect imports, then re-exports.
//
// Import order matters: audit must load before identity (identity uses
// logAudit), and keys must load after identity (rotateKey calls
// updatePreferences). The order here matches the design doc sequence.
import { Ledger } from "./core.js";
import "./audit.js";
import "./keys.js";
import "./identity.js";
import "./timeline.js";
import "./events.js";
import "./facts.js";

export { Ledger };
