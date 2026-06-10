#!/usr/bin/env node
// The `usrcp` command is implemented in the usrcp-local package; this
// meta-package exists so `npm i -g usrcp` installs a working CLI under the
// base name. Importing usrcp-local's entry (the "." export → dist/index.js)
// runs its CLI against the current process argv.
import "usrcp-local";
