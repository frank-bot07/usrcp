#!/usr/bin/env node

const cmd = process.argv[2];

async function main(): Promise<number> {
  switch (cmd) {
    case "init":
    case "serve":
    case "status":
      console.error(`[usrcp-stream] '${cmd}' is not implemented yet`);
      return 2;
    default:
      console.error("usage: usrcp-stream <init|serve|status>");
      return 1;
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
