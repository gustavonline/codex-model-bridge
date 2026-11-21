import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, permissionAnswer, catalogOf, agentDefinition, googleEndpoints, mcpRelay } from '../antigravity.mjs';

// The Antigravity adapter's own contract, against a scripted ACP agent (real stdio JSON-RPC, no Google, no agy). The live proof is
// scripts/live-antigravity.mjs; this pins the sequence, the catalog, the permission answer, cancellation and teardown offline.
const AGENT = `
const rl = require('node:readline').createInterface({ input: process.stdin }); const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
const log = m => process.stderr.write(JSON.stringify(m) + '\\n'); let pending = null, nextId = 1000;
const options = [{ id: 'model', type: 'select', currentValue: 'gemini-flash', options: [{ value: 'gemini-flash', name: 'Gemini Flash' }, { value: 'claude-sonnet', name: 'Claude Sonnet' }] },
  { id: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }];
rl.on('line', line => { const m = JSON.parse(line); log({ got: m.method ?? 'response', params: m.params, result: m.result });
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] } });
  else if (m.method === 'authenticate') send({ jsonrpc: '2.0', id: m.id, result: {} });
  else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1', configOptions: options } });
  else if (m.method === 'session/set_config_option') send({ jsonrpc: '2.0', id: m.id, result: {} });
  else if (m.method === 'session/prompt' && m.params.prompt[0].text === 'tools') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FOREIGN' } } } });
    for (const [i, title] of [['p1', 'Run mcp_codex_find_tools'], ['p2', 'Run mcp_codex_evil'], ['p3', 'Run mcp_other_find_tools'], ['p4', 'touch x']]) send({ jsonrpc: '2.0', id: i, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { title }, options: [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }] } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
    setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } }), 50);
  } else if (m.method === 'session/prompt') { pending = m.id; send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '1' } } } }); }
  else if (m.method === 'session/cancel' && pending) { send({ jsonrpc: '2.0', id: pending, result: { stopReason: 'cancelled' } }); pending = null; }
});
rl.on('close', () => process.exit(0));`;
function harness() {
  const calls = { start: null, stderr: '' };
  const start = async opts => {
    calls.start = opts; const child = spawn(process.execPath, ['-e', AGENT], { stdio: ['pipe', 'pipe', 'pipe'] }); child.stderr.on('data', d => { calls.stderr += d; });
    return { child, mcpUrl: 'http://127.0.0.1:18081/mcp', decisions: [], close: async () => { child.stdin.end(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)); calls.closed = true; return { state: 'exited' }; } };
  };
  const seen = () => calls.stderr.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { calls, start, seen };
}
const base = h => ({ executable: process.execPath, cwd: mkdtempSync(join(tmpdir(), 'bridge-agy-')), home: '/home/someone', agentName: 'bridge-mcp-abc', mcpServe: stream => stream.destroy(), codexTools: new Set(['find_tools', 'call_tool']), start: h.start, available: () => true });

test('without the process boundary nothing is started and the refusal says why', async () => {
  let started = false;
  await assert.rejects(open({ ...base(harness()), available: () => false, start: async () => { started = true; } }), { code: 'harness_boundary_unavailable' });
  assert.equal(started, false);
});

test('a session runs inside the boundary with the Google-account route, the account\'s own catalog and the Codex MCP endpoint; choices outside the catalog are refused', async () => {
  const h = harness(), s = await open(base(h)), opts = h.calls.start;
  assert.deepEqual(opts.allow, [...googleEndpoints]); assert.deepEqual(opts.writable, ['/home/someone/.gemini']); assert.ok(opts.args.includes('--agent') && opts.args.at(-1) === 'bridge-mcp-abc');
  assert.deepEqual(opts.readable, [mcpRelay], 'only the fixed stdio relay is added inside'); assert.ok(opts.mcpSocket.startsWith(opts.runDir + '/'), 'the exact socket the Mac grant names');
  assert.match(opts.cwd, /bridge-agy-cwd-/, 'agy works in a generated empty directory, never the workspace'); assert.notEqual(opts.cwd, base(h).cwd);
  assert.deepEqual(Object.keys(opts.env).filter(k => !['HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TZ', 'SSH_CONNECTION', 'AGY_CLI_DISABLE_AUTO_UPDATE', 'PYTHONUNBUFFERED'].includes(k)), [], 'only the allowlisted environment'); assert.ok(!Object.keys(opts.env).some(k => /^(GEMINI_API|GOOGLE_)/.test(k)));
  assert.deepEqual(s.catalog, { models: [{ id: 'gemini-flash', name: 'Gemini Flash' }, { id: 'claude-sonnet', name: 'Claude Sonnet' }], levels: ['low', 'high'], current: { model: 'gemini-flash', level: 'high' } });
  await s.configure({ model: 'claude-sonnet', level: 'low' });
  await assert.rejects(s.configure({ model: 'gemini-neon' }), { code: 'model_not_available' }); await assert.rejects(s.configure({ level: 'max' }), { code: 'unsupported_reasoning_effort' });
  const sent = h.seen().map(m => m.got);
  assert.deepEqual(sent.filter(x => x !== 'response'), ['initialize', 'authenticate', 'session/new', 'session/set_config_option', 'session/set_config_option'], 'nothing unknown was sent');
  // ACP's mandatory stdio MCP form: agy launches the fixed relay to Bridge's own Unix socket in the sandbox run directory.
  const sessionNew = h.seen().find(m => m.got === 'session/new').params, [server] = sessionNew.mcpServers; assert.equal(sessionNew.cwd, opts.cwd, 'the session lives in the empty directory');
  assert.deepEqual([sessionNew.mcpServers.length, server.name, server.command, server.args[0], server.env], [1, 'codex', process.execPath, mcpRelay, []]);
  assert.equal(server.args[1], opts.mcpSocket);
  assert.equal(h.seen().find(m => m.got === 'authenticate').params.methodId, 'oauth-personal');
  await s.close(); assert.equal(h.calls.closed, true);
});

test('only Bridge\'s own Codex tools are allowed; another server, a lookalike name or a native tool is denied; foreign sessions are ignored', async () => {
  const h = harness(), events = [], s = await open({ ...base(h), onEvent: e => events.push(e) });
  assert.deepEqual(await s.prompt('tools'), { stopReason: 'end_turn' });
  assert.deepEqual(events.filter(e => e.type === 'permission').map(e => [e.title, e.allowed]), [['Run mcp_codex_find_tools', true], ['Run mcp_codex_evil', false], ['Run mcp_other_find_tools', false], ['touch x', false]]);
  assert.deepEqual(h.seen().filter(m => m.got === 'response' && m.result?.outcome).map(m => m.result.outcome.optionId), ['a', 'r', 'r', 'r']);
  assert.deepEqual(events.filter(e => e.type === 'text').map(e => e.text), ['done'], 'the other session\'s text is not shown');
  await s.close();
});

test('cancel ends the running prompt as cancelled, and close ends the harness', async () => {
  const h = harness(), events = [], s = await open({ ...base(h), onEvent: e => events.push(e) });
  const running = s.prompt('count'); while (!events.some(e => e.type === 'text')) await new Promise(r => setTimeout(r, 5));
  s.cancel(); assert.deepEqual(await running, { stopReason: 'cancelled' }); await s.close(); assert.equal(h.calls.closed, true);
});

test('a prompt that outlives its bound is cancelled in the agent, not only abandoned', async () => {
  const h = harness(), s = await open(base(h));
  await assert.rejects(s.prompt('count', { timeoutMs: 100 }), { code: 'harness_timeout' });
  await new Promise(r => setTimeout(r, 50)); assert.ok(h.seen().some(m => m.got === 'session/cancel'), 'session/cancel was sent'); await s.close();
});

test('the permission answer and catalog parsing are total over odd input; the agent definition grants no native tool', () => {
  assert.equal(permissionAnswer({}, new Set(['x'])).allowed, false); assert.deepEqual(permissionAnswer({ toolCall: { title: 'Run mcp_codex_x' }, options: [] }, new Set(['x'])).outcome, { outcome: 'cancelled' });
  assert.deepEqual(catalogOf(null), { models: [], levels: [], current: { model: null, level: null } });
  assert.match(agentDefinition('bridge-mcp-1'), /\ntools: \[\]\n/); assert.match(agentDefinition('bridge-mcp-1'), /\nmainAgent: true\n/);
});

// A scripted agent answering `initialize` and then as `script` says ('silent' never answers; an error object answers with that error).
const scripted = script => async () => {
  const code = `const rl = require('node:readline').createInterface({ input: process.stdin }); const s = ${JSON.stringify(script)};
rl.on('line', line => { const m = JSON.parse(line); const a = m.method === 'initialize' ? { result: { protocolVersion: 1 } } : s[m.method];
  if (a && a !== 'silent') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...a }) + '\\n'); }); rl.on('close', () => process.exit(0));`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] }), box = { closed: false };
  const gone = () => child.exitCode !== null || child.signalCode !== null; // a killed child has a signal, not an exit code
  return Object.assign(box, { child, decisions: [], close: async () => { child.stdin.end(); await new Promise(r => gone() ? r() : child.once('exit', r)); box.closed = true; return { state: 'exited' }; } });
};

test('Stop while agy is still starting ends the start at once and closes its whole tree; nothing is sent', async () => {
  let box; const start = async o => (box = await scripted({ authenticate: 'silent' })(o));
  const stop = new AbortController(), began = Date.now();
  const opening = open({ ...base({ start }), signal: stop.signal });
  setTimeout(() => stop.abort(), 100);
  await assert.rejects(opening, { code: 'harness_aborted' });
  assert.ok(Date.now() - began < 3000, 'not after the 120 s request bound'); assert.equal(box.closed, true);
  await assert.rejects(open({ ...base({ start }), signal: AbortSignal.abort() }), { code: 'harness_aborted' }, 'an already stopped start never starts');
});

test('only agy refusing the resumed session itself is reported as a failed resume; a sign-in error stays a sign-in error', async () => {
  const refused = scripted({ authenticate: { result: {} }, 'session/resume': { error: { code: -32002, message: 'Session not found' } } });
  await assert.rejects(open({ ...base({ start: refused }), resume: 'old-session' }), { code: 'harness_resume_failed' });
  const signedOut = scripted({ authenticate: { error: { code: -32000, message: 'Authentication required' } } });
  await assert.rejects(open({ ...base({ start: signedOut }), resume: 'old-session' }), { code: 'harness_error' });
});

test('agy exiting during a resume is not a refused session; Stop while the boundary itself is starting returns at once and closes it when it exists', async () => {
  const dies = async () => { const box = await scripted({ authenticate: { result: {} } })(); setTimeout(() => box.child.kill(), 100); return box; };
  await assert.rejects(open({ ...base({ start: dies }), resume: 'old-session' }), { code: 'harness_exited' });
  const signIn = scripted({ authenticate: { result: {} }, 'session/resume': { error: { code: -32000, message: 'Authentication required' } } });
  await assert.rejects(open({ ...base({ start: signIn }), resume: 'old-session' }), { code: 'harness_error' }, 'a sign-in error from the resume call stays a sign-in error');
  let release, box; const slow = async o => { await new Promise(r => { release = r; }); return (box = await scripted({})(o)); };
  const stop = new AbortController(), opening = open({ ...base({ start: slow }), signal: stop.signal });
  while (!release) await new Promise(r => setTimeout(r, 5));
  stop.abort(); await assert.rejects(opening, { code: 'harness_aborted' }, 'before the boundary has started');
  release(); while (!box?.closed) await new Promise(r => setTimeout(r, 5)); assert.equal(box.closed, true, 'closed once it existed');
  let hung; const never = new Promise(r => { hung = r; }), stop2 = new AbortController();
  const waiting = open({ ...base({ start: scripted({}) }), available: () => never, signal: stop2.signal }); setTimeout(() => stop2.abort(), 50);
  await assert.rejects(waiting, { code: 'harness_aborted' }, 'a boundary check that hangs does not hold Stop'); hung(true);
});

test('Stop during the boundary check spawns nothing; a refusal mentioning "unauthorized" is still a refused session', async () => {
  let started = false; const stop = new AbortController();
  await assert.rejects(open({ ...base({ start: async () => { started = true; } }), available: () => { stop.abort(); return true; }, signal: stop.signal }), { code: 'harness_aborted' });
  assert.equal(started, false, 'no boundary was started after Stop');
  const refused = scripted({ authenticate: { result: {} }, 'session/resume': { error: { code: -32002, message: 'Session not found or unauthorized for this client' } } });
  await assert.rejects(open({ ...base({ start: refused }), resume: 'old-session' }), { code: 'harness_resume_failed' });
});
