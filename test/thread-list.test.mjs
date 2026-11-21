import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/fixture.mjs';

// thread/list against a native index that lists only threads with a native user turn, as Codex 0.166 and 0.171.0-alpha.13 do (measured with
// throwaway profiles: a host thread with injected items only is listed by no filter, not even includedThreadIds). A Claude chat's host has no
// native turn, so Bridge adds its own chats to the listing. Synthetic fixture host; the Mac sidebar itself is a desktop check.
const real = () => { const f = fixture('openai'); f.controls.nativeListing = 'materialized'; return f; };
const ids = page => page.data.map(t => t.id);
const list = (f, params = {}) => f.bridge.request('thread/list', { limit: 100, modelProviders: [], ...params });

test('a Claude chat with a turn is listed, before and after a Bridge restart, though native lists only its own GPT chat', async () => {
  const f = real(); try {
    const gpt = (await f.bridge.request('thread/start', { cwd: f.statePath })).thread.id; await f.bridge.request('turn/start', { threadId: gpt, input: [{ type: 'text', text: 'native' }] });
    const claude = await f.start('haiku'); const t = (await f.send(claude, 'hello claude')).turn; await f.done(t.id);
    const empty = await f.start('haiku');
    const native = await f.bridge.native.request('thread/list', { limit: 100, modelProviders: [] });
    assert.deepEqual(ids(native).sort(), [gpt].sort(), 'native alone lists only the GPT chat');
    let page = await list(f);
    assert.deepEqual(new Set(ids(page)), new Set([gpt, claude]), 'both chats; a chat without a turn is not listed, as native hides empty threads');
    assert.equal(page.data.find(r => r.id === claude).modelProvider, 'claude_code'); void empty;
    f.restart();
    page = await list(f); assert.deepEqual(new Set(ids(page)), new Set([gpt, claude]), 'and after a restart');
    assert.equal(page.data.find(r => r.id === claude).preview, 'hello claude', 'shown as Bridge holds it, never the native seed');
  } finally { f.close(); }
});

test('Bridge applies native\'s filters to its own chats and pages the merged listing with its own cursors', async () => {
  const f = real(); try {
    const made = [];
    for (let i = 0; i < 5; i++) { const id = await f.start('haiku'); const t = (await f.send(id, `chat ${i}`)).turn; await f.done(t.id); made.push(id); }
    await f.bridge.request('thread/archive', { threadId: made[0] });
    assert.ok(!ids(await list(f)).includes(made[0]), 'archived is not in the ordinary list');
    assert.ok(ids(await list(f, { archived: true })).includes(made[0]), 'but is in the archived one');
    assert.deepEqual(ids(await list(f, { searchTerm: 'CHAT 3' })), [made[3]], 'title search, case-insensitive');
    assert.deepEqual(ids(await list(f, { cwd: '/elsewhere' })), [], 'cwd');
    assert.deepEqual(new Set(ids(await list(f, { excludedThreadIds: [made[1]] }))), new Set(made.slice(2)), 'exclusions');
    assert.deepEqual(ids(await list(f, { includedThreadIds: [made[2]] })), [made[2]], 'inclusions');
    assert.deepEqual(ids(await list(f, { parentThreadId: made[1] })), [], 'ancestry Bridge cannot decide leaves its chats out');
    assert.deepEqual(ids(await list(f, { modelProviders: ['some-other-provider'] })), [], 'provider filter');
    // Paging: every chat exactly once, in one order, with a cursor bound to its listing.
    const seen = []; let cursor = null, pages = 0;
    do { const page = await list(f, { limit: 2, ...(cursor ? { cursor } : {}) }); seen.push(...ids(page)); cursor = page.nextCursor; pages++; } while (cursor && pages < 10);
    assert.deepEqual(new Set(seen), new Set(made.slice(1))); assert.equal(seen.length, 4); assert.equal(pages, 2);
    const first = await list(f, { limit: 1 });
    await assert.rejects(list(f, { limit: 1, cursor: first.nextCursor, searchTerm: 'chat' }), /does not belong to this listing/);
    await assert.rejects(list(f, { cursor: 'bridge-own:not-json' }), /does not belong to this listing/);
  } finally { f.close(); }
});

test('without a Bridge chat to add, thread/list is native\'s own paging, unchanged', async () => {
  const f = real(); try {
    const gpt = (await f.bridge.request('thread/start', { cwd: f.statePath })).thread.id; await f.bridge.request('turn/start', { threadId: gpt, input: [{ type: 'text', text: 'native' }] });
    const page = await list(f, { limit: 1 });
    assert.deepEqual(ids(page), [gpt]); assert.equal(page.nextCursor, null);
    assert.equal(f.calls.filter(c => c.method === 'thread/list').at(-1).params.limit, 1, 'native was asked exactly as the caller asked');
  } finally { f.close(); }
});
