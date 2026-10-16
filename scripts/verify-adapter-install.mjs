#!/usr/bin/env node
// Fresh consumer installs for every Node package. Does not publish or contact adapter services.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch=mkdtempSync(join(tmpdir(),'usrcp-adapter-pack-'));
const run=(cmd,args,cwd,extra={})=>execFileSync(cmd,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:180000,...extra});
try {
 const dirs=readdirSync(join(root,'packages')).filter(n=>{
  if(!existsSync(join(root,'packages',n,'package-lock.json')))return false;
  const pkg=JSON.parse(readFileSync(join(root,'packages',n,'package.json'),'utf8'));
  if(pkg.os && !pkg.os.includes(process.platform)){console.log('SKIP platform-specific package:',n);return false;}
  return true;
 });
 const manifests=Object.fromEntries(dirs.map(n=>[n,JSON.parse(readFileSync(join(root,'packages',n,'package.json'),'utf8'))]));
 const archives=[];
 for(const name of dirs){
  const source=join(root,'packages',name), stage=join(scratch,name);mkdirSync(stage);
  // Stage only publishable source artifacts; npm pack applies the package's own files rules.
  for(const item of readdirSync(source)) if(!['node_modules','.git','package-lock.json'].includes(item)) cpSync(join(source,item),join(stage,item),{recursive:true});
  if(!existsSync(join(stage,'LICENSE')))cpSync(join(root,'LICENSE'),join(stage,'LICENSE'));
  const pkg=manifests[name];
  for(const section of ['dependencies','optionalDependencies'])for(const [dep,spec] of Object.entries(pkg[section]??{}))if(spec.startsWith('file:')){
   if(!manifests[dep])throw new Error('Unknown local dependency '+dep);
   pkg[section][dep]=manifests[dep].version;
  }
  writeFileSync(join(stage,'package.json'),JSON.stringify(pkg,null,2));
  const [packed]=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',scratch],stage));
  if(!packed.files.some(f=>f.path==='LICENSE'))throw new Error(name+' lacks LICENSE');
  archives.push(join(scratch,packed.filename));
 }
 const consumer=join(scratch,'consumer');mkdirSync(consumer);
 writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'usrcp-adapter-consumer',private:true}));
 run('npm',['install','--omit=dev',...archives],consumer);
 for(const name of dirs){
  const installed=join(consumer,'node_modules',name),pkg=JSON.parse(readFileSync(join(installed,'package.json'),'utf8'));
  if(pkg.main&&!existsSync(join(installed,pkg.main)))throw new Error(name+' missing main');
  for(const entry of Object.values(typeof pkg.bin==='string'?{cli:pkg.bin}:pkg.bin??{}))if(!existsSync(join(installed,entry)))throw new Error(name+' missing CLI');
  console.log('PASS packed production install:',name);
 }
 const entry=join(consumer,'node_modules/usrcp-local/dist/index.js');
 run(process.execPath,[join(root,'scripts/cross-client-proof.mjs')],consumer,{env:{...process.env,USRCP_ENTRY:entry},stdio:'inherit'});
 run('npm',['audit','--omit=dev','--audit-level=moderate'],consumer,{stdio:'inherit'});
 console.log('All packed packages installed; protocol proof passed. Host UI and external-service acceptance remain separate.');
} finally { rmSync(scratch,{recursive:true,force:true}); }
