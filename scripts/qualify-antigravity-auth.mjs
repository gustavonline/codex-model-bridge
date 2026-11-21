// Explicit opt-in: where agy's Google sign-in can live so that Bridge's SANDBOXED sessions can use it (docs/harnesses.md, "Signing in with
// Google"). No prompt is ever sent and no model is called. Steps, in the order the architecture review set:
//   a     A1 + A2: inside the boundary (macOS: Codex's sandbox with local binding), on a Bridge-owned agy profile (--gemini-dir), agy's own
//         sign-in starts; the authorization URL it opens is captured by a recorder (nothing is opened) and checked; the host then probes
//         agy's localhost callback with a plain GET (any HTTP status passes). Without --wait the sign-in is cancelled there.
//   a --wait   A3 as well: the person completes the Google sign-in in their own browser (the URL is printed for them to open); then the
//         profile is listed (names and sizes, never contents) and ~/.gemini is checked unchanged.
//   a4    A4: a new sandboxed launch on that profile, with the remote marker, runs authenticate and session/new: the catalog, or "signed out".
//   login  agy's own documented sign-in, `agy acp --login`, INSIDE the boundary on the Bridge-owned profile. Its Google page is hosted
//         (antigravity.google), so no local listener is needed. It prints the URL for the person's own browser, and the one-time code they paste
//         in this terminal goes straight to agy's stdin (never to disk or a log). Inside the boundary the Keychain is unreachable, so agy should
//         keep the login in its file storage under the profile; the new profile files are listed (names and sizes only). Then run a4.
//   c1    C1: outside the boundary, the owner's own login (no --gemini-dir), with the marker: authenticate and session/new.
//   c4    C4: the same with a fresh --gemini-dir: signed in means agy's Keychain item is shared, refused means it is keyed per directory.
// Usage: node scripts/qualify-antigravity-auth.mjs <a|a4|c1|c4> --agy <absolute agy> --profile <absolute Bridge profile dir> [--wait]
//        (macOS also needs BRIDGE_REAL_CODEX: the desktop's Codex CLI). Prints one JSON report; secrets are never printed or read.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, isAbsolute, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { startSandboxed, sandboxAvailable, sandboxRunDir } from '../harness-sandbox.mjs';
import { googleEndpoints } from '../antigravity.mjs';
import { antigravityLaunch } from '../plugins/codex-claude/home/harnesses.mjs';
import { validSignInUrl, signedOut } from '../plugins/codex-claude/home/antigravity-auth.mjs';

const { positionals: [step], values } = parseArgs({ allowPositionals: true, options: { agy: { type: 'string' }, profile: { type: 'string' }, wait: { type: 'boolean', default: false } } });
if (!['a', 'a4', 'c1', 'c4', 'login'].includes(step) || !isAbsolute(values.agy ?? '') || (step !== 'c1' && !isAbsolute(values.profile ?? '')))
  throw new Error('Usage: <a|a4|c1|c4> --agy <absolute agy> --profile <absolute Bridge profile dir> [--wait]. Sends no prompt; calls no model.');
const report = { step, platform: process.platform, agy: realpathSync(values.agy), startedAt: new Date().toISOString() };
const t0 = Date.now(), ms = () => Date.now() - t0;
const out = () => { console.log(JSON.stringify(report, null, 1)); };
const redactUrl = u => { try { const x = new URL(u), back = new URL(x.searchParams.get('redirect_uri')); return { host: x.host, path: x.pathname, redirect: `${back.protocol}//${back.hostname}:${back.port}${back.pathname}` }; } catch { return { unparsable: true }; } };
// Names, sizes and times of a directory tree (never contents), for "unchanged" and "a login file appeared" checks.
const listing = dir => { const rows = []; const walk = d => { let names; try { names = readdirSync(d); } catch { return; } for (const n of names) { const p = join(d, n); let s; try { s = statSync(p); } catch { continue; } if (s.isDirectory()) { if (!['log', 'conversations', 'brain', 'crashes'].includes(n)) walk(p); } else rows.push([relative(dir, p), s.size, Math.floor(s.mtimeMs)]); } }; walk(dir); return rows.sort(); };

function peer(child) {
  let buf = '', id = 0; const waiting = new Map();
  child.stdout.on('data', b => { buf += b; let n; while ((n = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && !m.method) { waiting.get(m.id)?.(m); waiting.delete(m.id); } else if (m.id != null && m.method) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported in qualification' } }) + '\n'); } });
  child.once('exit', () => { for (const w of waiting.values()) w({ error: { message: 'agy exited' } }); waiting.clear(); });
  return (method, params, timeout) => new Promise(resolve => {
    const i = ++id, timer = setTimeout(() => { waiting.delete(i); resolve({ timeout: true }); }, timeout);
    waiting.set(i, m => { clearTimeout(timer); resolve(m); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
}
const init = rpc => rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'model-bridge-qualification', version: '0' } }, 30_000);
const answer = m => m.timeout ? 'timeout' : m.error ? (signedOut(m.error.message) ? 'signed_out' : 'error: ' + String(m.error.message).slice(0, 160)) : 'ok';

// One agy launch: inside the boundary (a, a4) or outside it (c1, c4). `interactive` drops the remote marker and installs the recorder.
async function launch({ inside, interactive, profile }) {
  // The empty working directory is outside the writable run directory (the boundary refuses a writable directory containing it), as in antigravity.mjs.
  const run = sandboxRunDir(), cwd = mkdtempSync(join(tmpdir(), 'bridge-agy-qual-cwd-')), bin = join(run, 'bin'), url = join(run, 'url'); mkdirSync(bin);
  if (profile) mkdirSync(profile, { recursive: true, mode: 0o700 });
  const spec = antigravityLaunch({ executable: realpathSync(values.agy), logDir: run, env: process.env, interactive, profile });
  let env = spec.env;
  if (interactive) {
    const recorder = `#!/bin/sh\nfor a in "$@"; do case "$a" in https://*) printf '%s' "$a" > '${url}.tmp' && mv '${url}.tmp' '${url}'; exit 0;; esac; done\nexit 0\n`;
    for (const name of ['open', 'xdg-open', 'sensible-browser']) writeFileSync(join(bin, name), recorder, { mode: 0o700 });
    env = { ...env, PATH: `${bin}:${env.PATH ?? '/usr/bin:/bin'}`, BROWSER: join(bin, 'open'), ...(process.platform === 'linux' ? { DISPLAY: process.env.DISPLAY ?? ':0' } : {}) };
  }
  if (!inside) {
    const child = spawn(spec.command, spec.args, { cwd, env: { ...env, ...Object.fromEntries(['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'].filter(k => process.env[k]).map(k => [k, process.env[k]])) }, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    const close = async () => { child.stdin.end(); try { process.kill(-child.pid, 'SIGTERM'); } catch {} await new Promise(r => setTimeout(r, 1500)); try { process.kill(-child.pid, 'SIGKILL'); } catch {} rmSync(run, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); };
    return { rpc: peer(child), url, run, cwd, close };
  }
  if (!(await sandboxAvailable())) throw new Error('The boundary is not available here (macOS: set BRIDGE_REAL_CODEX to the desktop\'s Codex CLI).');
  const box = await startSandboxed({ command: spec.command, args: spec.args, cwd, env, readable: [bin], writable: profile ? [profile] : [], allow: googleEndpoints, runDir: run, localBinding: true, upstream: undefined });
  report.boundary = process.platform === 'darwin' ? 'codex sandbox (local binding granted)' : 'bubblewrap';
  return { rpc: peer(box.child), url, run, cwd, close: async () => { report.close = await box.close(); rmSync(cwd, { recursive: true, force: true }); }, box };
}
const logHints = run => { try { return readFileSync(join(run, 'acp-server.log'), 'utf8').split('\n').filter(l => /refus|denied|blocked|not allowed|keychain|keyring|fallback|file storage|secret/i.test(l)).slice(-12).map(l => l.replace(/ya29\.[\w.-]+|1\/\/[\w.-]+|eyJ[\w.-]+/g, '<redacted>').slice(0, 240)); } catch { return []; } };

try {
  if (step === 'login') {
    if (!(await sandboxAvailable())) throw new Error('The boundary is not available here (macOS: set BRIDGE_REAL_CODEX to the desktop\'s Codex CLI).');
    mkdirSync(values.profile, { recursive: true, mode: 0o700 });
    const geminiBefore = listing(join(homedir(), '.gemini')), profileBefore = listing(values.profile);
    const run = sandboxRunDir(), cwd = mkdtempSync(join(tmpdir(), 'bridge-agy-qual-cwd-'));
    const spec = antigravityLaunch({ executable: realpathSync(values.agy), logDir: run, env: process.env, interactive: true, profile: values.profile });
    const args = ['acp', '--login', '--disable-telemetry', '--log-file', join(run, 'acp-server.log'), '--gemini-dir', values.profile];
    const box = await startSandboxed({ command: spec.command, args, cwd, env: spec.env, writable: [values.profile], allow: googleEndpoints, runDir: run, localBinding: false });
    report.boundary = process.platform === 'darwin' ? 'codex sandbox (no local binding)' : 'bubblewrap';
    // agy's own prompt goes to this terminal; what the person types goes to agy's stdin only. Neither is stored or added to the report.
    box.child.stdout.pipe(process.stderr); box.child.stderr.on('data', () => {});
    process.stdin.pipe(box.child.stdin);
    const code = await new Promise(r => box.child.once('exit', c => r(c)));
    process.stdin.unpipe(box.child.stdin); process.stdin.pause();
    report.login = { exitCode: code, ms: ms(), profileNew: listing(values.profile).filter(r => !profileBefore.some(b => b[0] === r[0])).map(([p, size]) => ({ path: p, size })),
      geminiUnchanged: JSON.stringify(listing(join(homedir(), '.gemini')).map(r => r.slice(0, 2))) === JSON.stringify(geminiBefore.map(r => r.slice(0, 2))), logHints: logHints(run) };
    report.close = await box.close(); rmSync(cwd, { recursive: true, force: true });
  } else if (step === 'a') {
    const geminiBefore = listing(join(homedir(), '.gemini')), profileBefore = listing(values.profile);
    const s = await launch({ inside: true, interactive: true, profile: values.profile });
    report.initialize = answer(await init(s.rpc));
    let auth = null; const authP = s.rpc('authenticate', { methodId: 'oauth-personal' }, values.wait ? 180_000 : 25_000).then(m => { auth = m; });
    while (!auth && !existsSync(s.url) && ms() < 25_000) await new Promise(r => setTimeout(r, 200));
    if (auth) report.A1 = { pass: false, result: answer(auth) === 'ok' ? 'complete at once without a URL (Keychain reachable or shared)' : answer(auth), ms: ms() };
    else if (!existsSync(s.url)) report.A1 = { pass: false, result: 'no authorization URL within 25 s (hang)', ms: ms() };
    else {
      const u = readFileSync(s.url, 'utf8'); report.A1 = { pass: validSignInUrl(u), url: redactUrl(u), ms: ms() };
      const back = new URL(new URL(u).searchParams.get('redirect_uri'));
      report.A2 = await fetch(`http://${back.hostname}:${back.port}/auth/callback`, { signal: AbortSignal.timeout(5000) }).then(r => ({ pass: true, status: r.status }), e => ({ pass: false, error: String(e.cause?.code ?? e.message).slice(0, 80) }));
      if (values.wait) {
        console.error(`\nOpen this URL in your own browser and complete the Google sign-in (up to 3 minutes):\n${u}\n`);
        await authP;
        report.A3 = { authenticate: answer(auth), ms: ms(), profileNew: listing(values.profile).filter(r => !profileBefore.some(b => b[0] === r[0])).map(([p, size]) => ({ path: p, size })),
          geminiUnchanged: JSON.stringify(listing(join(homedir(), '.gemini')).map(r => r.slice(0, 2))) === JSON.stringify(geminiBefore.map(r => r.slice(0, 2))), logHints: logHints(s.run) };
      } else report.A3 = 'not run (add --wait for the owner\'s sign-in)';
    }
    await s.close();
  } else {
    const inside = step === 'a4', profile = step === 'c1' ? null : step === 'c4' ? mkdtempSync(join(tmpdir(), 'bridge-agy-c4-')) : values.profile;
    const s = await launch({ inside, interactive: false, profile });
    report.initialize = answer(await init(s.rpc));
    const auth = await s.rpc('authenticate', { methodId: 'oauth-personal' }, 30_000); report.authenticate = answer(auth);
    if (report.authenticate === 'ok') {
      const session = await s.rpc('session/new', { cwd: s.cwd, mcpServers: [] }, 60_000);
      report.sessionNew = answer(session);
      const models = session.result?.models?.availableModels ?? session.result?.configOptions?.find(o => o.id === 'model')?.options ?? [];
      report.catalogModels = models.length;
    }
    report[step.toUpperCase()] = { pass: step === 'c4' ? null : report.authenticate === 'ok' && report.sessionNew === 'ok', ms: ms() };
    if (step === 'c4') report.C4 = { keychainItem: report.authenticate === 'ok' ? 'shared across profiles (signed in)' : report.authenticate === 'signed_out' ? 'keyed per profile (signed out)' : report.authenticate, ms: ms() };
    report.logHints = logHints(s.run);
    await s.close(); if (step === 'c4') rmSync(profile, { recursive: true, force: true });
  }
} catch (error) { report.error = String(error.message).slice(0, 300); }
out(); process.exit(0);
