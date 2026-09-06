#!/usr/bin/env node
// Verify the candidate tarballs, never a registry copy or a workspace link.
import { mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'usrcp-packed-'));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
try {
  const sources = ['packages/usrcp-core', 'packages/usrcp-local', 'release/extra-names/usrcp'];
  const manifests = sources.map(source => JSON.parse(readFileSync(join(root, source, 'package.json'), 'utf8')));
  const versions = Object.fromEntries(manifests.map(p => [p.name, p.version]));
  const tarballs = [];
  for (let i = 0; i < sources.length; i++) {
    const manifest = manifests[i];
    const stage = join(temp, manifest.name); mkdirSync(stage);
    for (const entry of ['dist', 'bin', 'LICENSE', 'README.md']) {
      const source = join(root, sources[i], entry);
      if (existsSync(source)) cpSync(source, join(stage, entry), { recursive: true });
    }
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (spec.startsWith('file:')) {
        if (!versions[name]) throw new Error(`Unstaged local dependency ${name}`);
        manifest.dependencies[name] = `^${versions[name]}`;
      }
    }
    writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
    const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], stage));
    if (!packed.files.some(f => f.path === 'LICENSE')) throw new Error(`${manifest.name} missing LICENSE`);
    if (manifest.engines.node !== '>=22.13.0') throw new Error(`${manifest.name} has inconsistent Node floor`);
    tarballs.push(join(temp, packed.filename));
  }
  const consumer = join(temp, 'consumer'); mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'usrcp-candidate-proof', private: true }));
  run('npm', ['install', '--ignore-scripts', '--omit=dev', ...tarballs], consumer);
  const entry = join(consumer, 'node_modules/usrcp/bin/usrcp.mjs');
  console.log(run(process.execPath, [entry, '--help'], consumer));
  execFileSync(process.execPath, [join(root, 'scripts/cross-client-proof.mjs')], {
    cwd: consumer, env: { ...process.env, USRCP_ENTRY: entry }, stdio: 'inherit',
  });
  console.log(run('npm', ['audit', '--omit=dev', '--audit-level=high'], consumer));
  console.log('Candidate tarball install, licenses, Node floors and cross-process Markdown handoff passed.');
} finally { rmSync(temp, { recursive: true, force: true }); }
