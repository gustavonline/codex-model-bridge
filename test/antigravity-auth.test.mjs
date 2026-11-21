import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravitySignIn, validSignInUrl, signedOut } from '../plugins/codex-claude/home/antigravity-auth.mjs';
import { antigravityLaunch } from '../plugins/codex-claude/home/harnesses.mjs';

// Home's Gemini sign-in against a scripted stand-in for agy (offline: real ACP stdio, no Google). It answers `initialize`, and on
// `authenticate` calls the browser opener from PATH the way agy does, then completes when the test approves (writing a stand-in login file).
// Native proof of agy's own behaviour is recorded in docs/antigravity-qualification.md; this pins Bridge's side of it.
const GOOD = 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-x.apps.googleusercontent.com&code_challenge=' + 'a'.repeat(43)
  + '&code_challenge_method=S256&prompt=consent&redirect_uri=http%3A%2F%2Flocalhost%3A33265%2Fauth%2Fcallback&response_type=code&scope=openid&state=s';
const PASTE = GOOD.replace('http%3A%2F%2Flocalhost%3A33265%2Fauth%2Fcallback', 'https%3A%2F%2Fantigravity.google%2Foauth-callback');
function fakeAgy(url) {
  const home = mkdtempSync(join(tmpdir(), 'bridge-agy-auth-home-')), dir = mkdtempSync(join(tmpdir(), 'bridge-agy-auth-bin-')), agy = join(dir, 'agy');
  writeFileSync(agy, `#!${process.execPath}
const { execFileSync } = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
fs.writeFileSync(${JSON.stringify(join(home, 'env.json'))}, JSON.stringify({ env: process.env, args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  if (m.method === 'authenticate') {
    if (fs.existsSync(path.join(process.env.HOME, '.gemini/antigravity-cli/antigravity-oauth-token'))) { send({ jsonrpc: '2.0', id: m.id, result: {} }); return; }
    if (process.env.SSH_CONNECTION) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'No browser is available here (this is a remote (SSH) session)' } }); return; }
    execFileSync('open', [${JSON.stringify(url)}]);
    const t = setInterval(() => { if (!fs.existsSync(path.join(process.env.HOME, 'approve'))) return; clearInterval(t);
      fs.mkdirSync(path.join(process.env.HOME, '.gemini/antigravity-cli'), { recursive: true }); fs.writeFileSync(path.join(process.env.HOME, '.gemini/antigravity-cli/antigravity-oauth-token'), 'stand-in');
      send({ jsonrpc: '2.0', id: m.id, result: {} }); }, 20);
  } });
`, { mode: 0o755 });
  return { home, agy, env: () => JSON.parse(readFileSync(join(home, 'env.json'), 'utf8')), approve: () => writeFileSync(join(home, 'approve'), '') };
}
const until = async (check, what) => { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail(`timed out waiting for ${what}`); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('only a Google PKCE authorization returning to agy\'s own localhost callback is ever offered; a paste-code page never is', () => {
  assert.equal(validSignInUrl(GOOD), true);
  for (const bad of [PASTE, GOOD.replace('accounts.google.com', 'accounts.google.com.evil.example'), GOOD.replace('https://', 'http://'), GOOD.replace('code_challenge_method=S256', 'code_challenge_method=plain'),
    GOOD.replace('%2Fauth%2Fcallback', '%2Fother'), GOOD.replace('localhost%3A33265', 'example.com%3A33265'), GOOD + '#x', 'x'.repeat(5000), null])
    assert.equal(validSignInUrl(bad), false, String(bad).slice(0, 80));
  assert.ok(signedOut('authenticate: No browser is available here (this is a remote (SSH) session, so ...)'));
});

test('Home\'s Gemini sign-in runs agy\'s own browser sign-in: the URL agy opens is offered, Google\'s return completes it, and the login is then saved', async () => {
  const a = fakeAgy(GOOD), auth = new AntigravitySignIn({ env: { HOME: a.home, PATH: '/usr/bin:/bin', GOOGLE_API_KEY: 'ambient', GEMINI_API_KEY: 'ambient' } });
  assert.equal(auth.status(a.home).saved, false);
  await auth.begin(a.agy);
  await until(() => auth.status(a.home).phase === 'waiting', 'the browser step');
  assert.equal(auth.status(a.home).authorizationUrl, GOOD);
  const seen = a.env();
  assert.equal(seen.env.SSH_CONNECTION, undefined, 'the one launch where agy may open a browser');
  assert.deepEqual([seen.env.AGY_CLI_DISABLE_AUTO_UPDATE, seen.env.GOOGLE_API_KEY, seen.env.GEMINI_API_KEY], ['1', undefined, undefined], 'auto-update off, no ambient key');
  assert.equal(seen.env.AGY_ACP_FORCE_FILE_STORAGE, undefined, 'no variable agy 1.5.13 does not read');
  assert.equal(seen.args[0], 'acp'); assert.match(seen.cwd, /bridge-agy-signin-.*\/cwd$/, 'an empty generated directory, never a workspace');
  await assert.rejects(auth.begin(a.agy), { code: 'auth_in_progress' });
  a.approve(); await until(() => auth.status(a.home).phase === 'complete', 'completion');
  assert.deepEqual([auth.status(a.home).saved, auth.status(a.home).authorizationUrl], [true, null]);
  await until(() => !alive(seen.pid), 'agy to exit');
  await auth.begin(a.agy); await until(() => auth.status(a.home).phase === 'complete', 'an already signed-in profile');
});

test('a paste-code sign-in is refused and agy is ended; Cancel ends a pending sign-in and keeps nothing', async () => {
  const p = fakeAgy(PASTE), paste = new AntigravitySignIn({ env: { HOME: p.home, PATH: '/usr/bin:/bin' } });
  await paste.begin(p.agy); await until(() => paste.status(p.home).phase === 'failed', 'the refusal');
  assert.deepEqual([paste.status(p.home).error, paste.status(p.home).authorizationUrl, paste.status(p.home).saved], ['auth_unsupported_flow', null, false]);
  await until(() => !alive(p.env().pid), 'agy to exit');
  const c = fakeAgy(GOOD), cancel = new AntigravitySignIn({ env: { HOME: c.home, PATH: '/usr/bin:/bin' } });
  await cancel.begin(c.agy); await until(() => cancel.status(c.home).phase === 'waiting', 'the browser step');
  cancel.cancel(); await until(() => cancel.status(c.home).phase === 'cancelled', 'cancellation');
  await until(() => !alive(c.env().pid), 'agy to exit'); assert.equal(existsSync(join(c.home, '.gemini/antigravity-cli/antigravity-oauth-token')), false);
  const t = fakeAgy(GOOD), slow = new AntigravitySignIn({ env: { HOME: t.home, PATH: '/usr/bin:/bin' }, ttlMs: 300 });
  await slow.begin(t.agy); await until(() => slow.status(t.home).phase === 'expired', 'expiry'); await until(() => !alive(t.env().pid), 'agy to exit');
});

test('every launch but Home\'s sign-in carries the remote marker, so a signed-out agy refuses at once instead of opening a browser or waiting', () => {
  const session = antigravityLaunch({ executable: '/opt/agy', logDir: '/run/x', env: { HOME: '/h', PATH: '/bin', SSH_CONNECTION: 'from the shell' } });
  const signIn = antigravityLaunch({ executable: '/opt/agy', logDir: '/run/x', env: { HOME: '/h', PATH: '/bin', SSH_CONNECTION: 'from the shell' }, interactive: true });
  assert.equal(session.env.SSH_CONNECTION, '127.0.0.1 0 127.0.0.1 0', 'set by Bridge, whatever the shell had');
  assert.equal(signIn.env.SSH_CONNECTION, undefined);
});

test('Home shows Gemini sign-in where agy is found: Sign in with Google, then Open browser with the validated URL, then signed in', async () => {
  const { prepareProviderHome, providerControls } = await import('../plugins/codex-claude/home/provider-controls.mjs');
  const { session } = await import('../plugins/codex-claude/home/server.mjs');
  const { harness, hostReply, handshakeId, toolResult } = await import('./support/home-host.mjs');
  const candidate = process.env.BRIDGE_ANTIGRAVITY_MAC; process.env.BRIDGE_ANTIGRAVITY_MAC = '1'; // a Mac host stands in for Linux's boundary here
  const a = fakeAgy(GOOD), p = prepareProviderHome(join(mkdtempSync(join(tmpdir(), 'bridge-agy-home-')), 'scope'));
  const controls = providerControls(p.bindingPath, { find: () => a.agy, home: a.home, agyAuthOptions: { env: { HOME: a.home, PATH: '/usr/bin:/bin' } } });
  try {
    const server = session(undefined, controls);
    server({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }); server({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const read = () => server({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_home', arguments: {} } }).result.structuredContent;
    const nodes = n => [n, ...n.children.flatMap(nodes)];
    const show = () => {
      const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {}, openLinks: {} } })); h.deliver(toolResult(read()));
      const gear = [...nodes(h.elements['header-actions']), ...nodes(h.elements.controls)].find(n => n.tag === 'button' && n.getAttribute('aria-label') === 'Connections'); for (const fn of gear.listeners.click ?? []) fn({});
      const buttons = nodes(h.elements.controls).filter(n => n.tag === 'button').map(n => [n.textContent, n.disabled]);
      return { h, buttons, text: h.text('controls') };
    };
    let v = show();
    assert.doesNotMatch(v.text, /Connection setup is not available here/); assert.match(v.text, /No Google sign-in saved for Model Bridge yet/);
    assert.deepEqual(v.buttons.find(b => b[0] === 'Sign in with Google'), ['Sign in with Google', false]);
    const c = read().controls; await controls.call('harness_sign_in', { bindingId: c.bindingId, profileId: c.profileId, bridgeId: c.bridgeId, revision: c.revision, harness: 'antigravity' });
    await until(() => read().controls.agyAuth.phase === 'waiting', 'the browser step');
    v = show(); assert.match(v.text, /Finish signing in with Google in your browser/);
    assert.deepEqual(v.buttons.filter(b => ['Open browser', 'Cancel sign-in'].includes(b[0])), [['Open browser', false], ['Cancel sign-in', false]]);
    a.approve(); await until(() => read().controls.agyAuth.phase === 'complete', 'completion');
    v = show(); assert.match(v.text, /Sign-in complete\. Gemini models appear in the model picker/); assert.ok(v.buttons.some(b => b[0] === 'Sign in again'));
  } finally { controls.close(); if (candidate === undefined) delete process.env.BRIDGE_ANTIGRAVITY_MAC; else process.env.BRIDGE_ANTIGRAVITY_MAC = candidate; }
});

test('a sign-in that cannot launch agy reports a code Home knows, keeps Home readable, and leaves no run directory', async () => {
  const { readdirSync } = await import('node:fs');
  const runs = () => readdirSync(tmpdir()).filter(n => n.startsWith('bridge-agy-signin-')).length, before = runs();
  const auth = new AntigravitySignIn({ env: { HOME: '/nonexistent-home', PATH: '/usr/bin:/bin' } });
  await assert.rejects(auth.begin('/nonexistent/agy'), e => /^[a-z_]{1,40}$/.test(e.code));
  assert.match(auth.status('/nonexistent-home').error, /^[a-z_]{1,40}$/); assert.equal(auth.status('/nonexistent-home').phase, 'failed');
  assert.equal(runs(), before, 'no run directory left behind');
});

test('agy answering "signed in" without saving a login the sessions can read is not a completed sign-in (the macOS Keychain case)', async () => {
  const a = fakeAgy(GOOD), elsewhere = mkdtempSync(join(tmpdir(), 'bridge-agy-auth-other-'));
  // The stand-in is already signed in through its own HOME; Bridge's sessions read another home, where nothing is saved.
  const { mkdirSync } = await import('node:fs'); mkdirSync(join(a.home, '.gemini/antigravity-cli'), { recursive: true }); writeFileSync(join(a.home, '.gemini/antigravity-cli/antigravity-oauth-token'), 'stand-in');
  const auth = new AntigravitySignIn({ env: { HOME: a.home, PATH: '/usr/bin:/bin' } });
  await auth.begin(a.agy, elsewhere); await until(() => !['starting', 'waiting'].includes(auth.status(elsewhere).phase), 'the answer');
  assert.deepEqual([auth.status(elsewhere).phase, auth.status(elsewhere).error, auth.status(elsewhere).saved], ['failed', 'auth_not_usable', false]);
});

test('a Bridge-owned agy profile is agy\'s own --gemini-dir, absolute only', () => {
  assert.deepEqual(antigravityLaunch({ executable: '/opt/agy', logDir: '/run/x', env: {}, profile: '/state/antigravity-profile' }).args.slice(-2), ['--gemini-dir', '/state/antigravity-profile']);
  assert.ok(!antigravityLaunch({ executable: '/opt/agy', logDir: '/run/x', env: {} }).args.includes('--gemini-dir'), 'none unless asked');
  assert.throws(() => antigravityLaunch({ executable: '/opt/agy', logDir: '/run/x', env: {}, profile: 'relative' }), { code: 'route_invalid' });
});
