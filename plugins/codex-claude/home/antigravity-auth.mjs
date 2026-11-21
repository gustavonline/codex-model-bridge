// Gemini (Antigravity) sign-in from Home, through agy's own ACP sign-in: `authenticate` with the Google-account method. On a signed-out
// profile on this machine agy opens the browser itself, Google returns to agy's own localhost callback, and agy stores its login where it
// keeps it (its file storage on a host without a keyring; the OS keyring otherwise: on macOS the Keychain, which the sandbox cannot read, so
// the macOS route is not settled; docs/harnesses.md). Bridge never sees a code, token or password and offers no paste field: the browser opener agy
// calls is a recorder, Home opens that URL through the host's own link opening, and any URL that is not a Google authorization returning to
// agy's localhost callback is refused.
// The sign-in agy runs outside the chat boundary because the browser's redirect must reach its listener. It runs in an empty directory with
// the same environment allowlist, creates no session, runs no model and is given no tools; it ends when the sign-in ends.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { antigravityLaunch } from './harnesses.mjs';

// The one URL shape Home will open: Google's OAuth authorization with PKCE, returning to agy's own loopback listener.
export function validSignInUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096) return false;
    const url = new URL(value), back = new URL(url.searchParams.get('redirect_uri'));
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && ['/o/oauth2/auth', '/o/oauth2/v2/auth'].includes(url.pathname) && !url.hash && !url.username && !url.password
      && url.searchParams.get('response_type') === 'code' && url.searchParams.get('code_challenge_method') === 'S256' && !!url.searchParams.get('client_id')
      && back.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(back.hostname) && /^[0-9]{2,5}$/.test(back.port) && back.pathname === '/auth/callback' && !back.search && !back.hash;
  } catch { return false; }
}
const failure = (code, message) => Object.assign(new Error(message), { code });
// What agy says when a signed-out profile cannot open a browser (Bridge's sessions set the remote marker on purpose).
export const signedOut = message => /No browser is available|not (signed|logged) in|sign.?in required|authentication required|login required/i.test(String(message ?? ''));

// One line-delimited JSON-RPC peer over agy's stdio (ACP), with bounded requests.
function acp(child) {
  let buf = '', id = 0; const waiting = new Map();
  const end = () => { for (const w of waiting.values()) w({ error: { message: 'Antigravity ended' }, exited: true }); waiting.clear(); };
  child.stdout.on('data', b => {
    buf += b; let n;
    while ((n = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, n); buf = buf.slice(n + 1); let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && !m.method) { waiting.get(m.id)?.(m); waiting.delete(m.id); }
      else if (m.id != null && m.method) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported during sign-in' } }) + '\n');
    }
  });
  child.once('exit', end); child.stdin.on('error', end);
  return (method, params, ms) => new Promise((resolve, reject) => {
    const i = ++id, timer = setTimeout(() => { waiting.delete(i); reject(failure('auth_timeout', `Antigravity did not finish ${method} in time`)); }, ms);
    waiting.set(i, m => { clearTimeout(timer); m.error ? reject(failure(m.exited ? 'auth_exited' : 'auth_error', String(m.error.message ?? 'failed').slice(0, 400))) : resolve(m.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
}

export class AntigravitySignIn {
  constructor({ spawnImpl = spawn, ttlMs = 180_000, env = process.env } = {}) {
    Object.assign(this, { spawnImpl, ttlMs, env });
    this.phase = 'idle'; this.authorizationUrl = null; this.error = null; this.attempt = null;
  }
  status(home) { return { phase: this.phase, authorizationUrl: this.phase === 'waiting' ? this.authorizationUrl : null, error: this.error, saved: !!home && this.saved(home) }; }
  // Starts agy for sign-in: the one launch where it may open a browser (through the recorder).
  launch(executable) {
    if (!isAbsolute(executable ?? '')) throw failure('harness_runtime_not_found', 'Antigravity (agy) is not installed');
    const run = mkdtempSync(join(tmpdir(), 'bridge-agy-signin-')), bin = join(run, 'bin'), cwd = join(run, 'cwd'), url = join(run, 'url');
    try { return this.start(executable, run, bin, cwd, url); } catch (error) { rmSync(run, { recursive: true, force: true }); throw error; }
  }
  start(executable, run, bin, cwd, url) {
    mkdirSync(bin); mkdirSync(cwd);
    // The opener agy calls (macOS `open`, Linux `xdg-open`, or $BROWSER) records the URL for Home; it opens nothing itself.
    const sq = s => `'${s.replace(/'/g, `'\\''`)}'`;
    const recorder = `#!/bin/sh\nfor a in "$@"; do case "$a" in https://*) printf '%s' "$a" > ${sq(url + '.tmp')} && mv ${sq(url + '.tmp')} ${sq(url)}; exit 0;; esac; done\nexit 0\n`;
    for (const name of ['open', 'xdg-open', 'sensible-browser']) writeFileSync(join(bin, name), recorder, { mode: 0o700 });
    const spec = antigravityLaunch({ executable: realpathSync(executable), logDir: run, env: this.env, interactive: true });
    const env = { ...spec.env, PATH: `${bin}:${spec.env.PATH ?? '/usr/bin:/bin'}`, BROWSER: join(bin, 'open') };
    const child = this.spawnImpl(spec.command, spec.args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    child.on('error', () => {});
    const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000); t.unref?.(); };
    const exited = new Promise(r => child.exitCode !== null || child.signalCode ? r() : child.once('exit', r));
    const close = async () => { child.stdin.end(); stop(); await Promise.race([exited, new Promise(r => setTimeout(r, 3000).unref?.())]); rmSync(run, { recursive: true, force: true }); };
    return { child, rpc: acp(child), url, close };
  }
  // Begin a browser sign-in. Already signed in is a completed sign-in at once (agy opens nothing).
  async begin(executable, home = this.env.HOME) {
    if (this.attempt) throw failure('auth_in_progress', 'A Gemini sign-in is already in progress');
    const attempt = this.attempt = { cancelled: false };
    Object.assign(this, { phase: 'starting', authorizationUrl: null, error: null });
    let run;
    try { run = attempt.run = this.launch(executable); }
    catch (error) {
      // Only codes Home knows are shown (an errno such as ENOENT would fail Home's validator and blank its controls).
      this.attempt = null; Object.assign(this, { phase: 'failed', error: error.code === 'harness_runtime_not_found' ? error.code : 'auth_failed' });
      throw Object.assign(new Error(error.message), { code: this.error });
    }
    const watch = setInterval(() => {
      let found; try { found = readFileSync(run.url, 'utf8'); } catch { return; }
      if (attempt.url === found) return; attempt.url = found;
      if (validSignInUrl(found)) Object.assign(this, { phase: 'waiting', authorizationUrl: found });
      else { attempt.refused = true; run.close(); } // a paste-code or any other page is never offered
    }, 150);
    const finish = (phase, error = null) => {
      clearInterval(watch); if (this.attempt === attempt) this.attempt = null;
      Object.assign(this, { phase, error, authorizationUrl: null });
      return run.close();
    };
    (async () => {
      try {
        await run.rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'model-bridge', version: '0.3.0' } }, 30_000);
        await run.rpc('authenticate', { methodId: 'oauth-personal' }, this.ttlMs);
        // agy's answer alone is not a usable sign-in: on macOS it reuses a Keychain login the sandboxed sessions cannot read (measured). Complete
        // only when the login Bridge's sessions read was saved.
        await finish(attempt.cancelled ? 'cancelled' : this.saved(home) ? 'complete' : 'failed', attempt.cancelled || this.saved(home) ? null : 'auth_not_usable');
      } catch (error) {
        await finish(attempt.cancelled ? 'cancelled' : attempt.refused ? 'failed' : error.code === 'auth_timeout' ? 'expired' : 'failed',
          attempt.cancelled ? null : attempt.refused ? 'auth_unsupported_flow' : error.code === 'auth_timeout' ? null : 'auth_failed');
      }
    })();
    return this.status();
  }
  cancel() { const attempt = this.attempt; if (!attempt) return this.status(); attempt.cancelled = true; attempt.run?.close(); return this.status(); }
  // Whether a file-storage login is saved where Bridge's sandboxed sessions can read it (agy 1.5's own file, never read here). A saved login is not
  // proof it still works: a chat's turn says so if Google refuses it.
  saved(home) { try { const s = statSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')); return s.isFile() && s.size > 0; } catch { return false; } }
}
