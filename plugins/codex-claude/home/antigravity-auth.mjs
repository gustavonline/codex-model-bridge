// Gemini (Antigravity) sign-in from Home, through agy's own documented sign-in, `agy acp --login`, on Bridge's own agy profile
// (antigravityProfile). agy runs with the remote marker, as every launch does, so it keeps the login in that profile's own file storage
// rather than the OS keyring entry it otherwise shares across every profile (the owner's agy and its Keychain login are never touched). It
// prints a Google link whose page, hosted by Antigravity, shows a one-time code; the person pastes that code (or the page's URL) into Home,
// and it is written to agy's stdin once. Bridge keeps no copy: not on disk, in a log, in history or in Home's state.
// Ready is not agy's exit: Bridge's own sandboxed catalog probe on the same profile has to authenticate and list the account's models.
// The URL and reply checks follow T3 Code's (MIT, pingdotgg/t3code apps/server/src/provider/antigravityAuthSupport.ts at 630f2e1;
// docs/upstream-reference.md). The sign-in runs outside the chat boundary (it needs no listener, only Google's endpoints): in an empty
// directory, with the environment allowlist, no session, no model and no tools, and it ends with the sign-in.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { antigravityLaunch } from './harnesses.mjs';

// Where `agy acp --login` sends Google; that page shows the code the person pastes back.
export const CODE_REDIRECT = 'https://antigravity.google/oauth-callback';
const maxUrl = 8192;
// The one link Home will open: Google's authorization for the code flow, with exactly one state and the hosted Antigravity redirect.
export function parseSignInUrl(value) {
  if (typeof value !== 'string' || value.length > maxUrl || /\s/.test(value)) return null;
  let url; try { url = new URL(value); } catch { return null; }
  const one = k => url.searchParams.getAll(k).length === 1, state = url.searchParams.get('state');
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/auth' || url.username || url.password || url.hash
    || !one('state') || !one('redirect_uri') || !one('response_type') || url.searchParams.get('response_type') !== 'code'
    || !state || state.length > 512 || url.searchParams.get('redirect_uri') !== CODE_REDIRECT) return null;
  return { url: value, state };
}
// What agy reads back: the code the Antigravity page shows, or that page's full URL, which must answer THIS sign-in (same redirect, the same
// single state, one code). Anything else, including any line break, is refused.
export function loginResponse(pending, response) {
  const value = String(response ?? '').trim();
  if (/^[\w./~-]{1,2048}$/.test(value)) return value;
  if (value.length > maxUrl || /\s/.test(value)) return undefined;
  let url; try { url = new URL(value); } catch { return undefined; }
  if (`${url.origin}${url.pathname}` !== CODE_REDIRECT || url.username || url.password || url.searchParams.getAll('state').length !== 1
    || url.searchParams.get('state') !== pending.state || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code')) return undefined;
  return value;
}
const failure = code => Object.assign(new Error(code), { code });
// What agy says when a signed-out profile cannot open a browser (every launch carries the remote marker on purpose).
export const signedOut = message => /No browser is available|not (signed|logged) in|sign.?in required|authentication required|login required/i.test(String(message ?? ''));

export class AntigravitySignIn {
  constructor({ spawnImpl = spawn, ttlMs = 600_000, env = process.env, onSignedIn = () => {} } = {}) {
    Object.assign(this, { spawnImpl, ttlMs, env, onSignedIn });
    this.phase = 'idle'; this.authorizationUrl = null; this.error = null; this.attempt = null;
  }
  status() { return { phase: this.phase, authorizationUrl: this.phase === 'waiting' ? this.authorizationUrl : null, error: this.error }; }
  set(phase, error = null) { Object.assign(this, { phase, error }); if (phase !== 'waiting') this.authorizationUrl = null; }
  // Start agy's sign-in on `profile`. Resolves once agy is running; the link arrives as `waiting`.
  async begin(executable, profile) {
    if (this.attempt) throw failure('auth_in_progress');
    if (!isAbsolute(executable ?? '') || !isAbsolute(profile ?? '')) { this.set('failed', 'harness_runtime_not_found'); throw failure('harness_runtime_not_found'); }
    const run = mkdtempSync(join(tmpdir(), 'bridge-agy-signin-')), cwd = join(run, 'cwd');
    let child;
    try {
      mkdirSync(cwd); mkdirSync(profile, { recursive: true, mode: 0o700 });
      const spec = antigravityLaunch({ executable: realpathSync(executable), logDir: run, env: this.env, profile, login: true });
      child = this.spawnImpl(spec.command, spec.args, { cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (error) { rmSync(run, { recursive: true, force: true }); this.set('failed', error.code === 'harness_runtime_not_found' ? error.code : 'auth_failed'); throw failure(this.error); }
    const attempt = this.attempt = { child, run, pending: null, sent: false, cancelled: false, refused: false };
    this.set('starting');
    let closed = null;
    attempt.stop = () => closed ??= (async () => {
      try { child.stdin.end(); } catch { /* gone */ }
      const gone = () => child.exitCode !== null || child.signalCode !== null;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
      await Promise.race([new Promise(r => gone() ? r() : child.once('exit', r)), new Promise(r => setTimeout(r, 2000).unref?.())]);
      if (!gone()) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(run, { recursive: true, force: true });
    })();
    child.stdin.on('error', () => {}); child.on('error', () => { if (child.exitCode === null) child.emit('exit', 127, null); });
    // agy prints its link on stdout (the prompt may go to either stream); only the first Google link is taken, nothing else is kept.
    let seen = '';
    const read = chunk => {
      if (attempt.pending || attempt.refused) return;
      seen = (seen + chunk).slice(-16384);
      const link = /https:\/\/accounts\.google\.com\/\S+/.exec(seen)?.[0]; if (!link) return;
      const parsed = parseSignInUrl(link);
      if (!parsed) { attempt.refused = true; attempt.stop(); return; } // not the code flow agy documents: never offered
      attempt.pending = parsed; this.authorizationUrl = parsed.url; this.set('waiting');
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    const timer = setTimeout(() => { attempt.expired = true; attempt.stop(); }, this.ttlMs); timer.unref?.();
    child.once('exit', code => {
      clearTimeout(timer); if (this.attempt === attempt) this.attempt = null;
      attempt.stop();
      if (attempt.cancelled) this.set('cancelled');
      else if (attempt.refused) this.set('failed', 'auth_unsupported_flow');
      else if (attempt.expired) this.set('expired');
      else if (code === 0 && attempt.sent) { this.set('verifying'); this.onSignedIn(); }
      else this.set('failed', attempt.sent ? 'auth_code_rejected' : 'auth_failed');
    });
    return this.status();
  }
  // The person's reply: written to agy's stdin once, then dropped. Refused unless a link is pending and the reply answers it.
  submit(response) {
    const attempt = this.attempt;
    if (!attempt || this.phase !== 'waiting' || !attempt.pending || attempt.sent) throw failure('auth_not_waiting');
    const value = loginResponse(attempt.pending, response);
    if (value === undefined) throw failure('auth_code_invalid');
    attempt.sent = true; attempt.child.stdin.write(value + '\n');
    this.set('verifying');
    return this.status();
  }
  cancel() { const attempt = this.attempt; if (!attempt) return this.status(); attempt.cancelled = true; attempt.stop(); return this.status(); }
}
