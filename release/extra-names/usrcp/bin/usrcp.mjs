#!/usr/bin/env node
// The `usrcp` command is implemented in the usrcp-local package; this
// meta-package exists so `npm i -g usrcp` installs a working CLI under the
// base name. usrcp-local's entry (the "." export → dist/index.js) is
// side-effect-free on import (its dispatch is guarded by require.main, which is
// never this module when imported from ESM), so invoke its CLI explicitly.
import { runCli } from "usrcp-local";

runCli();
