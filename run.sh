#!/bin/bash
cd /Users/frankbot/usrcp
npm install better-sqlite3 --no-save
npm run build --if-present
node init-ledger.js
