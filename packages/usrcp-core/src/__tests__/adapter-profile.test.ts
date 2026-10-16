import { it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setUserSlug, getUserSlug, getAdapterConfigPath, selectAdapterUser } from "../encryption.js";
let home: string; let old: string | undefined;
beforeEach(() => { old = process.env.HOME; home = fs.mkdtempSync(path.join(os.tmpdir(), "usrcp-profile-")); process.env.HOME = home; setUserSlug("default"); });
afterEach(() => { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; setUserSlug("default"); fs.rmSync(home, {recursive: true,force:true}); });
function user(name: string) { const dir=path.join(home,'.usrcp/users',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'ledger.db'),''); }
it('refuses ambiguous selection before creating or opening a ledger', () => {
 user('first');user('second');expect(()=>selectAdapterUser([])).toThrow('Multiple');
 expect(selectAdapterUser(['--user=second'])).toBe('second');expect(getUserSlug()).toBe('second');
});
it('does not initialize a missing profile on adapter startup', () => {
 expect(()=>selectAdapterUser(['--user=missing'])).toThrow('Initialize');expect(fs.existsSync(path.join(home,'.usrcp/users/missing'))).toBe(false);
});
it('isolates named-profile adapter credentials and cursors while retaining the legacy default path', () => {
 const legacy=getAdapterConfigPath('github-config.json');expect(legacy).toBe(path.join(home,'.usrcp/github-config.json'));
 setUserSlug('first');const first=getAdapterConfigPath('github-config.json');
 setUserSlug('second');expect(getAdapterConfigPath('github-config.json')).not.toBe(first);expect(first).not.toBe(legacy);
});
it('rejects missing or unsafe user arguments', () => {
 expect(()=>selectAdapterUser(['--user'])).toThrow();expect(()=>selectAdapterUser(['--user=../escape'])).toThrow();
});

it('migrates a legacy sole ledger before the startup existence check', () => {
 const base=path.join(home,'.usrcp');fs.mkdirSync(base);fs.writeFileSync(path.join(base,'ledger.db'),'legacy');
 expect(selectAdapterUser([])).toBe('default');
 expect(fs.readFileSync(path.join(base,'users/default/ledger.db'),'utf8')).toBe('legacy');
});
