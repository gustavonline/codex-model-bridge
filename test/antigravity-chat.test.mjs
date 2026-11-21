import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/fixture.mjs';
import { sessionNamespace } from '../sessions.mjs';
import { harnessModelId } from '../plugins/codex-claude/home/harnesses.mjs';

// An Antigravity chat in Bridge's core with a scripted session in place of agy (offline): picker rows, start, streamed turns, resume,
// cancel, refusals and the shared mailbox. The live proof is test/live-antigravity-child.test.mjs (opt-in).
const MODEL = harnessModelId('antigravity', 'google', 'gemini-x');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function agy(f, { hold } = {}) {
  const opened = [], cancelled = [];
  f.bridge.platform = 'linux'; // the platform under test is explicit (a macOS test sets darwin after this), never the host's
  f.bridge.antigravityCatalog = async () => ({ models: [{ id: MODEL, model: 'gemini-x', name: 'Gemini X' }], levels: ['low', 'high'] });
  f.bridge.antigravityRuntime = () => ({ executable: '/opt/agy', home: '/home/x' });
  f.bridge.antigravityAgent = () => 'bridge-mcp-000000000000';
  f.bridge.antigravityOpen = async opts => {
    const sessionId = opts.resume ?? 'agy-' + randomUUID(); opened.push({ resume: opts.resume ?? null, sessionId, localBinding: opts.localBinding });
    return { sessionId, catalog: { models: [{ id: 'gemini-x' }], levels: ['low', 'high'] }, configure: async () => {},
      prompt: async text => { opts.onEvent({ type: 'text', text: 'echo:' }); opts.onEvent({ type: 'text', text: text.split('\n').at(-1) }); if (hold) { const r = await hold.promise; return r; } return { stopReason: 'end_turn' }; },
      cancel: () => { cancelled.push(sessionId); hold?.resolve({ stopReason: 'cancelled' }); }, close: async () => ({ state: 'exited' }) };
  };
  return { opened, cancelled };
}
const start = async f => (await f.bridge.request('thread/start', { model: MODEL, cwd: f.statePath })).thread.id;

test('qualified Antigravity models are offered under their routes; nothing is offered without a catalog', async () => {
  const f = fixture(); try {
    assert.ok(!(await f.bridge.request('model/list', {})).data.some(m => m.id.startsWith('bridge-harness/')), 'no catalog, no rows');
    f.bridge.agyCatalogReady = { models: [{ id: MODEL, model: 'gemini-x', name: 'Gemini X' }], levels: ['low', 'high'] };
    f.bridge.antigravityRuntime = () => ({ executable: '/opt/agy', home: '/home/x' });
    const row = (await f.bridge.request('model/list', {})).data.find(m => m.id === MODEL);
    assert.deepEqual([row.displayName, row.isDefault, row.defaultReasoningEffort, row.supportedReasoningEfforts.map(e => e.reasoningEffort)], ['Gemini X · Antigravity', false, 'low', ['low', 'high']]);
    // Turned off in Home: gone from the list and refused for a new chat at once, though the catalog is still cached.
    f.bridge.antigravityRuntime = () => null;
    assert.ok(!(await f.bridge.request('model/list', {})).data.some(m => m.id === MODEL), 'turned off, not offered');
    await assert.rejects(f.bridge.request('thread/start', { model: MODEL, cwd: f.statePath }), /Antigravity|harness|not/i);
    assert.equal(f.bridge.records.size, 0, 'no chat was created');
  } finally { f.close(); }
});

test('an Antigravity chat starts on its model, streams a turn into Codex items, and its next turn resumes the same agy session', async () => {
  const f = fixture(), a = agy(f); try {
    const id = await start(f), record = f.bridge.records.get(id);
    assert.deepEqual([record.provider, record.model, record.harnessModel], ['antigravity', MODEL, 'gemini-x']);
    const one = (await f.send(id, 'first')).turn; await f.done(one.id);
    const two = (await f.send(id, 'second')).turn; await f.done(two.id);
    const turns = f.bridge.records.get(id).turns;
    assert.deepEqual(turns.map(t => t.status), ['completed', 'completed']);
    assert.equal(turns[1].items.find(i => i.type === 'agentMessage').text, 'echo:second');
    assert.deepEqual(a.opened.map(o => o.resume), [null, a.opened[0].sessionId], 'the second turn resumed the first turn\'s session');
    assert.ok(f.events.some(e => e.method === 'item/agentMessage/delta' && e.params.threadId === id), 'streamed');
    assert.equal(f.queries.length, 0, 'never the Claude SDK');
  } finally { f.close(); }
});

test('Stop cancels the agy prompt and ends the turn interrupted', async () => {
  const hold = deferred(), f = fixture(), a = agy(f, { hold }); try {
    const id = await start(f), turn = (await f.send(id, 'long')).turn;
    while (!a.opened.length) await new Promise(r => setTimeout(r, 5)); await new Promise(r => setTimeout(r, 20));
    await f.bridge.request('turn/interrupt', { threadId: id, turnId: turn.id }); await f.done(turn.id);
    assert.equal(f.bridge.records.get(id).turns[0].status, 'interrupted'); assert.equal(a.cancelled.length >= 1, true);
  } finally { hold.resolve({ stopReason: 'cancelled' }); f.close(); }
});

test('what an Antigravity chat cannot do is refused with the reason and changes nothing', async () => {
  const f = fixture(); agy(f); try {
    const id = await start(f), first = (await f.send(id, 'x')).turn; await f.done(first.id);
    const before = JSON.stringify(f.bridge.records.get(id));
    for (const [method, params] of [['thread/revert', { beforeTurnId: first.id }], ['thread/fork', {}], ['turn/steer', { expectedTurnId: first.id, input: [{ type: 'text', text: 's' }] }],
      ['thread/settings/update', { model: 'gpt-test' }], ['turn/start', { model: 'sonnet', input: [{ type: 'text', text: 'm' }] }]])
      await assert.rejects(f.bridge.request(method, { threadId: id, ...params }), e => /Antigravity|harness|keeps its model|not available/.test(e.message), method);
    await assert.rejects(f.bridge.request('turn/start', { threadId: id, input: [{ type: 'image', url: 'data:image/png;base64,AA==' }] }), /text messages/);
    assert.equal(JSON.stringify(f.bridge.records.get(id)), before, 'nothing changed');
  } finally { f.close(); }
});

test('the shared mailbox works from an Antigravity child exactly as from a Claude child', async () => {
  const hold = deferred(), f = fixture('openai', { coordinateNative: true }); agy(f, { hold }); try {
    const parent = (await f.bridge.request('thread/start', { cwd: f.statePath })).thread.id;
    await f.bridge.nativeNotification('turn/started', { threadId: parent, turn: { id: 'p1', status: 'inProgress' } });
    const call = async (threadId, turnId, tool, args) => { const r = await f.bridge.toolRequest('item/tool/call', { namespace: sessionNamespace, threadId, turnId, callId: randomUUID(), tool, arguments: args }); return r.success ? JSON.parse(r.contentItems[0].text) : { error: r.contentItems[0].text }; };
    const created = await call(parent, 'p1', 'manage', { operation: 'create', model: 'antigravity/gemini-x', text: 'Ask me a question.', requestId: 'agy-child-000001' });
    assert.ok(created.threadId, JSON.stringify(created)); assert.equal(f.bridge.records.get(created.threadId).provider, 'antigravity');
    while (!f.bridge.active.get(created.threadId)) await new Promise(r => setTimeout(r, 5));
    const asked = await call(created.threadId, f.bridge.active.get(created.threadId).turn.id, 'mailbox', { operation: 'report', kind: 'question', text: 'Which file?', requestId: 'agy-ask-0000001' });
    assert.equal(asked.delivered, true);
    assert.deepEqual((await call(parent, 'p1', 'mailbox', { operation: 'inbox' })).data.map(m => [m.kind, m.text]), [['question', 'Which file?']]);
  } finally { hold.resolve({ stopReason: 'end_turn' }); await new Promise(r => setTimeout(r, 50)); f.close(); }
});

test('Gemini models join the same library and saved slots: a saved one is offered, an unselected one stays hidden, and a cold catalog keeps the selection as unavailable', async () => {
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { prepareProviderHome, providerControls } = await import('../plugins/codex-claude/home/provider-controls.mjs');
  const { ProviderRegistry } = await import('../plugins/codex-claude/home/providers.mjs');
  const p = prepareProviderHome(join(mkdtempSync(join(tmpdir(), 'bridge-agy-slots-')), 'scope')), registry = new ProviderRegistry(p.state);
  const OTHER = harnessModelId('antigravity', 'google', 'gemini-y'), ready = { models: [{ id: MODEL, model: 'gemini-x', name: 'Gemini X' }, { id: OTHER, model: 'gemini-y', name: 'Gemini Y' }], levels: ['low', 'high'] };
  const on = b => { b.agyCatalogReady = ready; b.antigravityRuntime = () => ({ executable: '/opt/agy', home: '/home/x' }); };
  const f = fixture('openai', { connectionRoot: p.state }); on(f.bridge);
  // Home's card reads the host platform: on a Mac host the qualification switch stands in for Linux's boundary.
  const candidate = process.env.BRIDGE_ANTIGRAVITY_MAC; process.env.BRIDGE_ANTIGRAVITY_MAC = '1';
  try {
    await f.bridge.request('model/list', {});
    const catalog = registry.pickerCatalog(), agy = catalog.models.filter(m => m.kind === 'antigravity');
    assert.deepEqual(agy.map(m => [m.id, m.available, m.defaultVisible]), [[MODEL, true, false], [OTHER, true, false]], 'in the library, available, never shown by default');
    registry.savePickerSlots(['gpt-test', MODEL], registry.slots().revision, catalog.revision);
    let ids = (await f.bridge.request('model/list', {})).data.map(m => m.id);
    assert.ok(ids.includes(MODEL) && !ids.includes(OTHER), 'the saved Gemini model is offered, the unselected one is hidden');
    f.restart(); on(f.bridge);
    ids = (await f.bridge.request('model/list', {})).data.map(m => m.id); assert.ok(ids.includes(MODEL) && !ids.includes(OTHER), 'and after a restart');
    f.restart(); f.bridge.agyCatalogReady = null; f.bridge.antigravityRuntime = () => null; // cold: not loaded (or turned off)
    ids = (await f.bridge.request('model/list', {})).data.map(m => m.id); assert.ok(!ids.includes(MODEL), 'not offered while it cannot run');
    assert.deepEqual(registry.pickerCatalog().models.filter(m => m.kind === 'antigravity').map(m => [m.id, m.available]), [[MODEL, false], [OTHER, false]], 'kept in the library as unavailable');
    assert.deepEqual(registry.slots().models, ['gpt-test', MODEL], 'the saved selection is never rewritten');
    // Home shows it as a connected provider while it is on, its models unavailable while the catalog is cold.
    const { setHarnessEnabled } = await import('../plugins/codex-claude/home/harnesses.mjs');
    const card = () => providerControls(p.bindingPath).snapshot().providers.find(x => x.kind === 'antigravity');
    assert.deepEqual([card().enabled, card().catalogState, card().models.every(m => m.available === false)], [false, 'stale', true]);
    setHarnessEnabled(p.state, 'antigravity', true, { platform: 'linux', find: () => process.execPath });
    assert.equal(card().enabled, true); assert.ok(!providerControls(p.bindingPath).snapshot().harnesses.some(h => h.id === 'antigravity'), 'no second row while it is a connected card');
  } finally { if (candidate === undefined) delete process.env.BRIDGE_ANTIGRAVITY_MAC; else process.env.BRIDGE_ANTIGRAVITY_MAC = candidate; f.close(); }
});

test('on macOS a Gemini turn runs only in a full-access chat (agy needs a local listener); any other chat is refused and never widened', async () => {
  const f = fixture(), a = agy(f); f.bridge.platform = 'darwin'; try {
    const id = await start(f), record = f.bridge.records.get(id);
    assert.equal(record.sandbox.type, 'readOnly');
    await assert.rejects(f.send(id, 'x'), /runs only in chats with full access/); assert.equal(a.opened.length, 0, 'no agy process, nothing sent');
    assert.equal(f.bridge.records.get(id).sandbox.type, 'readOnly', 'its permissions are unchanged');
    record.sandbox = { type: 'dangerFullAccess' }; // as native confirmed for a full-access chat
    const t = (await f.send(id, 'y')).turn; await f.done(t.id);
    assert.deepEqual([f.bridge.records.get(id).turns.at(-1).status, a.opened.at(-1).localBinding], ['completed', true]);
    record.sandbox = { type: 'workspaceWrite', networkAccess: true, writableRoots: [], excludeSlashTmp: false, excludeTmpdirEnvVar: false };
    await assert.rejects(f.send(id, 'z'), /runs only in chats with full access/, 'a later turn after its permissions narrowed is refused too');
    f.bridge.platform = 'linux'; const u = (await f.send(id, 'w')).turn; await f.done(u.id);
    assert.equal(a.opened.at(-1).localBinding, false, 'Linux never asks for it (bubblewrap isolates loopback)');
  } finally { f.close(); }
});

test('macOS gaps closed: no catalog probe without consent, a lost grant stops the running turn, native outranks a saved grant, a child is decided on its own record', async () => {
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { setHarnessEnabled, readHarnessSettings } = await import('../plugins/codex-claude/home/harnesses.mjs');
  // 1. the catalog probe (no chat) on a Mac needs the consent stored by Home's Turn on
  const root = mkdtempSync(join(tmpdir(), 'bridge-agy-consent-')), f = fixture('openai', { connectionRoot: root }); f.bridge.platform = 'darwin';
  const opened = []; f.bridge.antigravityRuntime = () => ({ executable: process.execPath, home: '/h' }); f.bridge.antigravityAgent = () => 'bridge-mcp-000000000000';
  const { sandboxAvailable } = await import('../harness-sandbox.mjs'); void sandboxAvailable;
  const before = process.env.BRIDGE_AGY, candidate = process.env.BRIDGE_ANTIGRAVITY_MAC; delete process.env.BRIDGE_AGY; process.env.BRIDGE_ANTIGRAVITY_MAC = '1';
  try {
    const c = await f.bridge.antigravityCatalog({ refresh: true }); assert.equal(c.reason, 'local_listener_consent_required'); assert.equal(opened.length, 0);
    setHarnessEnabled(root, 'antigravity', true, { platform: 'darwin', find: () => process.execPath });
    assert.equal(readHarnessSettings(root).antigravity.localListener, true, 'Turn on on a Mac records the consent');
    setHarnessEnabled(root, 'antigravity', false, { platform: 'darwin' }); assert.equal(readHarnessSettings(root).antigravity.localListener, undefined, 'Turn off withdraws it');
  } finally { if (before !== undefined) process.env.BRIDGE_AGY = before; if (candidate === undefined) delete process.env.BRIDGE_ANTIGRAVITY_MAC; else process.env.BRIDGE_ANTIGRAVITY_MAC = candidate; f.close(); }
  // 2. a running full-access turn ends when the chat loses full access
  const hold = deferred(), g = fixture(), a = agy(g, { hold }); g.bridge.platform = 'darwin';
  try {
    const id = await start(g), record = g.bridge.records.get(id); record.sandbox = { type: 'dangerFullAccess' };
    g.bridge.ensureLoaded = async () => {}; // keep the native-confirmed full access of this synthetic chat
    const t = (await g.send(id, 'long')).turn; while (!a.opened.length) await new Promise(r => setTimeout(r, 5));
    assert.equal(a.opened[0].localBinding, true);
    await g.bridge.nativeNotification('thread/settings/updated', { threadId: id, threadSettings: { ...g.bridge.hostSettings(record), sandboxPolicy: { type: 'readOnly', networkAccess: false } } });
    await g.done(t.id); assert.equal(g.bridge.records.get(id).turns.at(-1).status, 'interrupted'); assert.ok(a.cancelled.length >= 1, 'agy was cancelled');
  } finally { hold.resolve({ stopReason: 'cancelled' }); g.close(); }
  // 3. a saved full-access grant does not survive what native reports after a restart
  const h = fixture(); agy(h); h.bridge.platform = 'darwin';
  try {
    const id = await start(h); const r = h.bridge.records.get(id); r.sandbox = { type: 'dangerFullAccess' }; h.bridge.save(r);
    h.restart(); agy(h); h.bridge.platform = 'darwin';
    await assert.rejects(h.send(id, 'x'), /runs only in chats with full access/); assert.equal(h.bridge.records.get(id).sandbox.type, 'readOnly', 'native\'s answer on reopen decides');
  } finally { h.close(); }
});

test('a Gemini child on macOS is decided on its own native-confirmed permissions, not its parent\'s', async () => {
  const hold = deferred(), f = fixture('openai', { coordinateNative: true }), a = agy(f, { hold }); f.bridge.platform = 'darwin';
  try {
    const parent = (await f.bridge.request('thread/start', { cwd: f.statePath })).thread.id;
    await f.bridge.nativeNotification('turn/started', { threadId: parent, turn: { id: 'p1', status: 'inProgress' } });
    f.bridge.nativeCallers.get(parent).sandbox = { type: 'dangerFullAccess' }; // the parent has full access
    const r = await f.bridge.toolRequest('item/tool/call', { namespace: sessionNamespace, threadId: parent, turnId: 'p1', callId: randomUUID(), tool: 'manage',
      arguments: { operation: 'create', model: 'antigravity/gemini-x', text: 'hello', requestId: 'agy-mac-child-01' } });
    const text = r.contentItems[0].text;
    assert.equal(r.success, false, 'the child (read-only as native reports it) refuses its first message'); assert.match(text, /did not receive the same permissions|full access/);
    assert.equal(a.opened.length, 0, 'no agy process for it');
  } finally { hold.resolve({ stopReason: 'end_turn' }); f.close(); }
});

test('an Antigravity chat reopens on its own model and session, before and after a restart, and its thinking level changes through settings', async () => {
  const f = fixture(), a = agy(f); try {
    const id = await start(f), one = (await f.send(id, 'first')).turn; await f.done(one.id);
    const session = a.opened[0].sessionId;
    const resumed = await f.bridge.request('thread/resume', { threadId: id, model: MODEL });
    assert.deepEqual([resumed.model, resumed.thread.id], [MODEL, id]);
    await assert.rejects(f.bridge.request('thread/resume', { threadId: id, model: 'gpt-test' }), /keeps its model/);
    assert.equal(f.bridge.records.get(id).model, MODEL, 'a refused reopen changed nothing');
    f.restart(); const b = agy(f);
    await f.bridge.request('thread/resume', { threadId: id, model: MODEL });
    const updated = f.wait(e => e.method === 'thread/settings/updated' && e.params.threadId === id);
    assert.deepEqual(await f.bridge.request('thread/settings/update', { threadId: id, effort: 'high' }), {});
    await updated; assert.equal(f.bridge.records.get(id).effort, 'high');
    await assert.rejects(f.bridge.request('thread/settings/update', { threadId: id, effort: 'xhigh' }), /Unsupported effort/);
    assert.equal(f.bridge.records.get(id).effort, 'high', 'a refused level changed nothing');
    const two = (await f.send(id, 'second')).turn; await f.done(two.id);
    assert.deepEqual([f.bridge.records.get(id).turns.at(-1).status, b.opened[0].resume], ['completed', session], 'after the restart the same agy session continues');
  } finally { f.close(); }
});

test('Stop or a lost grant while agy is still starting sends nothing and ends the turn interrupted', async () => {
  for (const how of ['stop', 'grant']) {
    const gate = deferred(), f = fixture(), a = agy(f), prompts = [], closed = []; if (how === 'grant') f.bridge.platform = 'darwin';
    const open = f.bridge.antigravityOpen;
    f.bridge.antigravityOpen = async opts => { await gate.promise; const s = await open(opts); return { ...s, prompt: async t => { prompts.push(t); return s.prompt(t); }, close: async () => { closed.push(1); return s.close(); } }; };
    try {
      const id = await start(f), record = f.bridge.records.get(id); record.sandbox = { type: 'dangerFullAccess' }; f.bridge.ensureLoaded = async () => {};
      const turn = (await f.send(id, 'hello')).turn; while (!f.bridge.active.get(id)?.query) await new Promise(r => setTimeout(r, 5));
      if (how === 'stop') await f.bridge.request('turn/interrupt', { threadId: id, turnId: turn.id });
      else await f.bridge.nativeNotification('thread/settings/updated', { threadId: id, threadSettings: { ...f.bridge.hostSettings(record), sandboxPolicy: { type: 'readOnly', networkAccess: false } } });
      gate.resolve(); await f.done(turn.id);
      assert.deepEqual([f.bridge.records.get(id).turns.at(-1).status, prompts.length, closed.length, a.opened.length], ['interrupted', 0, 1, 1], `${how}: opened, closed, nothing sent`);
    } finally { gate.resolve(); f.close(); }
  }
});

test('a session agy cannot resume is replaced once by a fresh one that carries the visible history; instructions follow a failed first prompt', async () => {
  const f = fixture(), a = agy(f), prompts = []; let failNext = true, refuseResume = false;
  const open = f.bridge.antigravityOpen;
  f.bridge.antigravityOpen = async opts => {
    if (opts.resume && refuseResume) { refuseResume = false; a.opened.push({ resume: opts.resume, refused: true }); throw Object.assign(new Error('session not found'), { code: 'harness_resume_failed' }); }
    const s = await open(opts);
    return { ...s, prompt: async t => { prompts.push(t); if (failNext) { failNext = false; throw new Error('network went away'); } return s.prompt(t); } };
  };
  try {
    const id = await start(f), one = (await f.send(id, 'first')).turn; await f.done(one.id);
    assert.equal(f.bridge.records.get(id).turns[0].status, 'failed');
    const two = (await f.send(id, 'second')).turn; await f.done(two.id);
    assert.match(prompts[0], /Model Bridge/); assert.match(prompts[1], /Model Bridge/, 'the instructions go again: the first prompt never completed');
    const three = (await f.send(id, 'third')).turn; await f.done(three.id);
    assert.doesNotMatch(prompts[2], /Model Bridge/, 'not repeated once delivered');
    refuseResume = true; const four = (await f.send(id, 'fourth')).turn; await f.done(four.id);
    const record = f.bridge.records.get(id);
    assert.equal(record.turns.at(-1).status, 'completed');
    assert.deepEqual(a.opened.slice(-2).map(o => [!!o.resume, !!o.refused]), [[true, true], [false, false]], 'one refused resume, then one fresh session');
    assert.match(prompts[3], /Model Bridge/); assert.match(prompts[3], /third/, 'the fresh session carries the earlier visible conversation');
    assert.equal(record.acpSessionId, a.opened.at(-1).sessionId);
  } finally { f.close(); }
});

test('a new Antigravity chat refuses automatic approval review, like any Model Bridge chat', async () => {
  const f = fixture(); agy(f); try {
    await assert.rejects(f.bridge.request('thread/start', { model: MODEL, cwd: f.statePath, approvalsReviewer: 'auto_review' }), /reviewed by the user/);
    assert.equal(f.bridge.records.size, 0);
    assert.ok(f.bridge.records.get(await (async () => (await f.bridge.request('thread/start', { model: MODEL, cwd: f.statePath, approvalsReviewer: 'user' })).thread.id)()));
  } finally { f.close(); }
});

test('an existing Gemini chat reopens on its own model while Antigravity is off or its catalog fails; a turn then says why and records nothing', async () => {
  const f = fixture(), a = agy(f); try {
    const id = await start(f), one = (await f.send(id, 'first')).turn; await f.done(one.id);
    f.restart(); agy(f); f.bridge.antigravityCatalog = async () => ({ models: [], levels: [], reason: 'catalog_failed' });
    assert.equal((await f.bridge.request('thread/resume', { threadId: id, model: MODEL })).thread.id, id, 'catalog failed: it still opens');
    await assert.rejects(f.bridge.request('thread/settings/update', { threadId: id, effort: 'low' }), /could not list your account's thinking levels \(catalog_failed\)/);
    f.restart(); const b = agy(f); f.bridge.antigravityRuntime = () => null; f.bridge.antigravityUnavailable = () => 'Gemini (Antigravity) is turned off in Model Bridge Home, so nothing was sent.';
    assert.equal((await f.bridge.request('thread/resume', { threadId: id, model: MODEL })).thread.id, id, 'turned off: it still opens');
    assert.equal(f.bridge.records.get(id).turns.length, 1, 'with its history');
    await assert.rejects(f.send(id, 'second'), /turned off in Model Bridge Home/);
    await assert.rejects(f.bridge.request('thread/settings/update', { threadId: id, effort: 'low' }), /turned off in Model Bridge Home/);
    assert.deepEqual([f.bridge.records.get(id).turns.length, a.opened.length, b.opened.length], [1, 1, 0], 'no turn recorded, no agy started after the restart');
    await assert.rejects(f.bridge.request('thread/resume', { threadId: id, model: 'gpt-test' }), /keeps its model/);
  } finally { f.close(); }
});

test('creating a Gemini child while Antigravity is turned off is a definite refusal: a retry gets the same answer, never "uncertain"', async () => {
  const f = fixture('openai', { coordinateNative: true }); agy(f); try {
    const parent = (await f.bridge.request('thread/start', { cwd: f.statePath })).thread.id;
    await f.bridge.nativeNotification('turn/started', { threadId: parent, turn: { id: 'p1', status: 'inProgress' } });
    f.bridge.antigravityRuntime = () => null; // turned off after its catalog was cached
    const create = async () => { const r = await f.bridge.toolRequest('item/tool/call', { namespace: sessionNamespace, threadId: parent, turnId: 'p1', callId: randomUUID(), tool: 'manage',
      arguments: { operation: 'create', model: 'antigravity/gemini-x', text: 'hello', requestId: 'agy-off-child-01' } }); return r.contentItems[0].text; };
    const first = await create(), again = await create();
    assert.match(first, /turned off in Model Bridge Home|not available|has not passed/); assert.equal(again, first, 'the same refusal');
    assert.doesNotMatch(again, /uncertain/); assert.equal([...f.bridge.records.values()].filter(r => r.provider === 'antigravity').length, 0);
  } finally { f.close(); }
});

test('a malformed application context is refused before the turn exists or agy starts', async () => {
  const f = fixture(), a = agy(f); try {
    const id = await start(f);
    await assert.rejects(f.bridge.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'x' }], additionalContext: { bogus: { kind: 'command', value: 'rm -rf' } } }), /additional context/i);
    assert.deepEqual([f.bridge.records.get(id).turns.length, a.opened.length], [0, 0]);
  } finally { f.close(); }
});

test('a signed-out agy is reported as "sign in from Home": a turn fails as unauthorized at once, and a new chat is refused with the same step', async () => {
  const f = fixture(); agy(f); try {
    const id = await start(f);
    f.bridge.antigravityOpen = async () => { throw Object.assign(new Error('authenticate: No browser is available here (this is a remote (SSH) session, so the browser\'s sign-in redirect can\'t reach this machine).'), { code: 'harness_error' }); };
    const t = (await f.send(id, 'hello')).turn; await f.done(t.id);
    const turn = f.bridge.records.get(id).turns.at(-1);
    assert.deepEqual([turn.status, turn.error.codexErrorInfo], ['failed', 'unauthorized']); assert.match(turn.error.message, /choose Sign in with Google under Gemini/);
    f.bridge.antigravityCatalog = async () => ({ models: [], levels: [], reason: 'signed_out' });
    await assert.rejects(f.bridge.request('thread/start', { model: MODEL, cwd: f.statePath }), /not signed in for Model Bridge.*Sign in with Google/);
  } finally { f.close(); }
});

test('an account whose models have no thinking levels takes the "none" Bridge advertises for them', async () => {
  const f = fixture(); agy(f); f.bridge.antigravityCatalog = async () => ({ models: [{ id: MODEL, model: 'gemini-x', name: 'Gemini X' }], levels: [] }); try {
    const id = await start(f);
    assert.deepEqual(await f.bridge.request('thread/settings/update', { threadId: id, effort: 'none' }), {});
    await assert.rejects(f.bridge.request('thread/settings/update', { threadId: id, effort: 'high' }), /offers no thinking levels/);
  } finally { f.close(); }
});
