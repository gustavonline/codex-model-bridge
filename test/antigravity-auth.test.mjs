import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravitySignIn, parseSignInUrl, loginResponse, signedOut, CODE_REDIRECT } from '../plugins/codex-claude/home/antigravity-auth.mjs';
import { antigravityLaunch, antigravityProfile, agySignInRequestFile, agyVerifiedFile, readAgyFile, writeAgyFile } from '../plugins/codex-claude/home/harnesses.mjs';

// Home's Gemini sign-in (agy's own `acp --login` on Bridge's profile) against a scripted stand-in for agy: real stdio, no Google. It prints a
// Google link the way agy 1.5.13 does, reads one line from stdin, and on the expected code writes a stand-in login file into its --gemini-dir.
// What agy itself does is recorded in docs/antigravity-qualification.md; this pins Bridge's side of it.
const STATE = 'ab12cd34ef56gh78ij90kl';
const LINK = state => 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-x.apps.googleusercontent.com&code_challenge=' + 'a'.repeat(43)
  + `&code_challenge_method=S256&prompt=consent&redirect_uri=${encodeURIComponent(CODE_REDIRECT)}&response_type=code&scope=openid&state=${state}`;
function fakeAgy(link = LINK(STATE), { expect = '4/0Agood-code' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-agy-auth-bin-')), agy = join(dir, 'agy'), seen = join(dir, 'seen.json');
  writeFileSync(agy, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
const profile = args[args.indexOf('--gemini-dir') + 1];
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ env: process.env, args, cwd: process.cwd(), pid: process.pid }));
process.stdout.write('Open this link in a browser to log in with Google:\\n\\n  ' + ${JSON.stringify(link)} + '\\n\\nThen paste the authorization code, or the full URL of the page you land on, and press Enter: ');
let line = ''; process.stdin.on('data', d => { line += d; if (!line.includes('\\n')) return;
  const value = line.trim(), code = value.startsWith('https://') ? new URL(value).searchParams.get('code') : value;
  if (code !== ${JSON.stringify(expect)}) { process.stdout.write('\\nlogin failed: invalid_grant\\n'); process.exit(1); }
  fs.mkdirSync(path.join(profile, 'antigravity-cli'), { recursive: true }); fs.writeFileSync(path.join(profile, 'antigravity-cli', 'antigravity-oauth-token'), 'stand-in');
  process.stdout.write('\\nLogged in.\\n'); process.exit(0); });
process.stdin.on('end', () => { process.stdout.write('\\nlogin cancelled: no authorization code was entered\\n'); process.exit(1); });
`, { mode: 0o755 });
  return { agy, seen: () => JSON.parse(readFileSync(seen, 'utf8')) };
}
const until = async (check, what) => { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail(`timed out waiting for ${what}`); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const freshProfile = () => join(mkdtempSync(join(tmpdir(), 'bridge-agy-auth-state-')), 'antigravity-profile');

test('only Google\'s code-flow authorization to the hosted Antigravity page is offered; a reply must be a code or that page\'s URL for this sign-in', () => {
  assert.deepEqual(parseSignInUrl(LINK(STATE)), { url: LINK(STATE), state: STATE });
  for (const bad of [LINK(STATE).replace('accounts.google.com', 'accounts.google.com.evil.example'), LINK(STATE).replace('https://', 'http://'),
    LINK(STATE).replace(encodeURIComponent(CODE_REDIRECT), encodeURIComponent('http://127.0.0.1:4000/')), LINK(STATE) + '&state=second', LINK(STATE).replace(`&state=${STATE}`, ''),
    LINK(STATE).replace('response_type=code', 'response_type=token'), LINK(STATE) + '#x', LINK(STATE).replace('/o/oauth2/auth', '/o/oauth2/v2/auth'), 'x'.repeat(9000), null])
    assert.equal(parseSignInUrl(bad), null, String(bad).slice(0, 90));
  const pending = { state: STATE };
  assert.equal(loginResponse(pending, '  4/0Agood-code \n'), '4/0Agood-code');
  assert.equal(loginResponse(pending, `${CODE_REDIRECT}?state=${STATE}&code=4/0Agood-code`), `${CODE_REDIRECT}?state=${STATE}&code=4/0Agood-code`);
  for (const bad of [`${CODE_REDIRECT}?state=other&code=x`, `${CODE_REDIRECT}?state=${STATE}`, `${CODE_REDIRECT}?state=${STATE}&code=a&code=b`, `https://evil.example/oauth-callback?state=${STATE}&code=x`,
    'code with spaces', 'two\nlines', '', 'x'.repeat(2049)])
    assert.equal(loginResponse(pending, bad), undefined, bad.slice(0, 60));
  assert.ok(signedOut('authenticate: No browser is available here (this is a remote (SSH) session, so ...)'));
});

test('every launch carries the remote marker, so agy keeps the login in the profile\'s own file storage; the sign-in is agy\'s own acp --login on that profile', () => {
  const session = antigravityLaunch({ executable: '/opt/agy', logDir: '/run/x', env: { HOME: '/h', PATH: '/bin', SSH_CONNECTION: 'from the shell' }, profile: '/state/antigravity-profile' });
  const login = antigravityLaunch({ executable: '/opt/agy', logDir: '/run/x', env: { HOME: '/h', PATH: '/bin' }, profile: '/state/antigravity-profile', login: true });
  for (const spec of [session, login]) { assert.equal(spec.env.SSH_CONNECTION, '127.0.0.1 0 127.0.0.1 0', 'set by Bridge, whatever the shell had'); assert.deepEqual(spec.args.slice(-2), ['--gemini-dir', '/state/antigravity-profile']); }
  assert.deepEqual(login.args.slice(0, 2), ['acp', '--login']); assert.ok(!session.args.includes('--login'));
  assert.equal(antigravityProfile('/state'), '/state/antigravity-profile');
  assert.ok(!antigravityLaunch({ executable: '/opt/agy', logDir: '/run/x', env: {} }).args.includes('--gemini-dir'), 'none unless asked');
  assert.throws(() => antigravityLaunch({ executable: '/opt/agy', logDir: '/run/x', env: {}, profile: 'relative' }), { code: 'route_invalid' });
});

test('the sign-in offers agy\'s link, sends the person\'s code to agy once, and hands over to verification; agy ran on Bridge\'s profile with the marker and no ambient key', async () => {
  const a = fakeAgy(), profile = freshProfile(); let signedIn = 0;
  const auth = new AntigravitySignIn({ env: { HOME: '/nonexistent-home', PATH: '/usr/bin:/bin', GOOGLE_API_KEY: 'ambient', GEMINI_API_KEY: 'ambient' }, onSignedIn: () => { signedIn++; } });
  await auth.begin(a.agy, profile); await until(() => auth.status().phase === 'waiting', 'the link');
  assert.equal(auth.status().authorizationUrl, LINK(STATE));
  const seen = a.seen();
  assert.deepEqual([seen.args[0], seen.args[1], seen.args.at(-1), seen.env.SSH_CONNECTION, seen.env.GOOGLE_API_KEY, seen.env.GEMINI_API_KEY], ['acp', '--login', profile, '127.0.0.1 0 127.0.0.1 0', undefined, undefined]);
  assert.match(seen.cwd, /bridge-agy-signin-.*\/cwd$/, 'an empty generated directory, never a workspace');
  await assert.rejects(auth.begin(a.agy, profile), { code: 'auth_in_progress' });
  assert.throws(() => auth.submit(`${CODE_REDIRECT}?state=someone-else&code=4/0Agood-code`), { code: 'auth_code_invalid' }, 'a page answering another sign-in');
  assert.equal(auth.status().phase, 'waiting', 'a refused reply changes nothing');
  assert.deepEqual(auth.submit(' 4/0Agood-code '), { phase: 'verifying', authorizationUrl: null, error: null });
  assert.throws(() => auth.submit('4/0Agood-code'), { code: 'auth_not_waiting' }, 'sent once');
  await until(() => signedIn === 1, 'agy accepting it'); await until(() => !alive(seen.pid), 'agy to exit');
  assert.equal(auth.status().phase, 'verifying', 'agy accepting the code is not "ready": Bridge has to check it');
  assert.ok(existsSync(join(profile, 'antigravity-cli', 'antigravity-oauth-token')), 'the login landed in Bridge\'s profile');
  assert.equal(readdirSync(tmpdir()).filter(n => n.startsWith('bridge-agy-signin-')).some(n => existsSync(join(tmpdir(), n, 'cwd')) && n === seen.cwd.split('/').at(-2)), false, 'its run directory is removed');
});

test('a code Google refuses, a link agy should not offer, Cancel and expiry all end agy and keep nothing', async () => {
  const wrong = fakeAgy(), p1 = freshProfile(), w = new AntigravitySignIn({ env: { PATH: '/usr/bin:/bin' } });
  await w.begin(wrong.agy, p1); await until(() => w.status().phase === 'waiting', 'the link'); w.submit('4/0Awrong');
  await until(() => w.status().phase === 'failed', 'the refusal'); assert.equal(w.status().error, 'auth_code_rejected'); assert.ok(!existsSync(join(p1, 'antigravity-cli')));
  const loopback = fakeAgy(LINK(STATE).replace(encodeURIComponent(CODE_REDIRECT), encodeURIComponent('http://localhost:33265/auth/callback'))), l = new AntigravitySignIn({ env: { PATH: '/usr/bin:/bin' } });
  await l.begin(loopback.agy, freshProfile()); await until(() => l.status().phase === 'failed', 'the refusal');
  assert.deepEqual([l.status().error, l.status().authorizationUrl], ['auth_unsupported_flow', null]); await until(() => !alive(loopback.seen().pid), 'agy to exit');
  const c = fakeAgy(), cancel = new AntigravitySignIn({ env: { PATH: '/usr/bin:/bin' } });
  await cancel.begin(c.agy, freshProfile()); await until(() => cancel.status().phase === 'waiting', 'the link');
  cancel.cancel(); await until(() => cancel.status().phase === 'cancelled', 'cancellation'); await until(() => !alive(c.seen().pid), 'agy to exit');
  const t = fakeAgy(), slow = new AntigravitySignIn({ env: { PATH: '/usr/bin:/bin' }, ttlMs: 300 });
  await slow.begin(t.agy, freshProfile()); await until(() => slow.status().phase === 'expired', 'expiry'); await until(() => !alive(t.seen().pid), 'agy to exit');
  const missing = new AntigravitySignIn({ env: { PATH: '/usr/bin:/bin' } });
  await assert.rejects(missing.begin('/nonexistent/agy', freshProfile()), e => /^[a-z_]{1,40}$/.test(e.code)); assert.match(missing.status().error, /^[a-z_]{1,40}$/, 'a code Home knows');
});

test('Home: Sign in with Google once Gemini is on, then the link and a code field, then "verifying" until Bridge\'s sandboxed check answers, then signed in with the model count', async () => {
  const { prepareProviderHome, providerControls } = await import('../plugins/codex-claude/home/provider-controls.mjs');
  const { setHarnessEnabled } = await import('../plugins/codex-claude/home/harnesses.mjs');
  const { session } = await import('../plugins/codex-claude/home/server.mjs');
  const { harness, hostReply, handshakeId, toolResult } = await import('./support/home-host.mjs');
  const candidate = process.env.BRIDGE_ANTIGRAVITY_MAC; process.env.BRIDGE_ANTIGRAVITY_MAC = '1'; // a Mac host stands in for Linux's boundary here
  const a = fakeAgy(), p = prepareProviderHome(join(mkdtempSync(join(tmpdir(), 'bridge-agy-home-')), 'scope'));
  const controls = providerControls(p.bindingPath, { agyAuthOptions: { env: { PATH: '/usr/bin:/bin' } } });
  try {
    const server = session(undefined, controls);
    server({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }); server({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const read = () => server({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_home', arguments: {} } }).result.structuredContent;
    const nodes = n => [n, ...n.children.flatMap(nodes)];
    const show = () => {
      const h = harness(); h.deliver(hostReply(handshakeId(h), { hostCapabilities: { serverTools: {}, openLinks: {} } })); h.deliver(toolResult(read()));
      const gear = [...nodes(h.elements['header-actions']), ...nodes(h.elements.controls)].find(n => n.tag === 'button' && n.getAttribute('aria-label') === 'Connections'); for (const fn of gear.listeners.click ?? []) fn({});
      const summary = h.text('controls');
      const card = nodes(h.elements.controls).find(n => n.tag === 'button' && n.getAttribute('aria-label') === 'Gemini (Antigravity)'); for (const fn of card?.listeners.click ?? []) fn({}); // its detail holds the sign-in
      return { summary, buttons: nodes(h.elements.controls).filter(n => n.tag === 'button').map(n => n.textContent), inputs: nodes(h.elements.controls).filter(n => n.tag === 'input').map(n => [n.id, n.type]), text: h.text('controls') };
    };
    const call = async (action, extra = {}) => { const c = read().controls; return controls.call(action, { bindingId: c.bindingId, profileId: c.profileId, bridgeId: c.bridgeId, revision: c.revision, harness: 'antigravity', ...extra }); };
    assert.equal(read().controls.agyAuth.available, false, 'not offered before Gemini is turned on');
    setHarnessEnabled(p.state, 'antigravity', true, { platform: 'linux', find: () => a.agy });
    let v = show(); assert.doesNotMatch(v.summary, /Connection setup is not available here/); assert.match(v.summary, /Sign-in needed · open to sign in with Google/);
    assert.match(v.text, /No Google sign-in for Model Bridge yet/); assert.ok(v.buttons.includes('Sign in with Google'));
    await call('harness_sign_in'); await until(() => read().controls.agyAuth.phase === 'waiting', 'the link');
    v = show(); assert.ok(v.buttons.includes('Open Google sign-in') && v.buttons.includes('Send code') && v.buttons.includes('Cancel sign-in')); assert.deepEqual(v.inputs.find(i => i[0] === 'gemini-code'), ['gemini-code', 'password']);
    assert.equal(a.seen().args.at(-1), antigravityProfile(p.state), 'agy signed in on Bridge\'s own profile in the connection store');
    await assert.rejects(call('harness_sign_in_code', { code: 'not a code' }), { code: 'auth_code_invalid' });
    await call('harness_sign_in_code', { code: '4/0Agood-code' });
    await until(() => readAgyFile(p.state, agySignInRequestFile), 'the request for Bridge');
    assert.equal(read().controls.agyAuth.phase, 'verifying'); assert.match(show().text, /Checking the sign-in inside Model Bridge’s sandbox/);
    assert.doesNotMatch(JSON.stringify(read()), /good-code/, 'the code is nowhere in Home\'s state');
    for (const f of readdirSync(p.state, { recursive: true, withFileTypes: true }).filter(e => e.isFile())) assert.doesNotMatch(readFileSync(join(f.parentPath, f.name), 'utf8').slice(0, 100000), /good-code/, `nor in ${f.name}`);
    // Bridge's sandboxed probe answers an OLDER request: still verifying. Then it answers this one.
    writeAgyFile(p.state, agyVerifiedFile, { nonce: '0'.repeat(32), ok: true, models: 6, reason: null, at: Date.now() });
    assert.equal(read().controls.agyAuth.phase, 'verifying');
    writeAgyFile(p.state, agyVerifiedFile, { nonce: readAgyFile(p.state, agySignInRequestFile).nonce, ok: true, models: 6, reason: null, at: Date.now() });
    assert.deepEqual([read().controls.agyAuth.phase, read().controls.agyAuth.models], ['complete', 6]); v = show(); assert.match(v.text, /Sign-in verified: 6 models listed inside Model Bridge’s sandbox/); assert.match(v.summary, /Sign-in verified · 6 models/);
    writeAgyFile(p.state, agyVerifiedFile, { nonce: readAgyFile(p.state, agySignInRequestFile).nonce, ok: false, models: 0, reason: 'signed_out', at: Date.now() });
    assert.deepEqual([read().controls.agyAuth.phase, read().controls.agyAuth.error], ['failed', 'auth_not_usable'], 'a sandboxed check that is signed out is a failed sign-in');
  } finally { controls.close(); if (candidate === undefined) delete process.env.BRIDGE_ANTIGRAVITY_MAC; else process.env.BRIDGE_ANTIGRAVITY_MAC = candidate; }
});
