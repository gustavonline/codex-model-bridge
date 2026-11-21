# Upstream reference: T3 Code's Antigravity harness

Model Bridge's Antigravity adapter follows the official `agy acp` route that T3 Code (pingdotgg/t3code, MIT) runs. It is not a copy of T3's runtime: T3's `@t3tools/provider-acp` and `effect-acp` are private workspace packages coupled to Effect and T3's contracts. Bridge reuses only scoped, proven protocol logic, and credits it where it does.

**Ported code and its license:** the sign-in link and reply checks in `plugins/codex-claude/home/antigravity-auth.mjs` (`parseSignInUrl`, `loginResponse`) are adapted from T3's `antigravityAuthSupport.ts`. Copyright (c) 2026 T3 Tools Inc., MIT License. The full notice ships in both the npm package and the plugin as `plugins/codex-claude/licenses/t3code-MIT.txt`.

**Pinned reference:** `630f2e14440faa2a6a177cea1f280dae0a3ed9a8` (main, 21 November 2026), nightly `v0.1.12-nightly.20261121.5051`.

**Watched paths:**
- `apps/server/src/provider/AntigravityAuth.ts`
- `apps/server/src/provider/antigravityAuthSupport.ts`
- `apps/server/src/provider/antigravityCallback.ts`
- `apps/server/src/provider/AntigravityProvider.ts`
- `apps/server/src/provider/Drivers/AntigravityDriver.ts`
- `apps/server/src/provider/acp/`
- `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts`
- `packages/provider-acp/`
- `docs/user/providers-antigravity.md`

Before changing the Antigravity harness, run `node scripts/check-upstream.mjs`. It lists what changed on those paths since the pin, using the project's GitHub access: a read-only GET of GitHub's public compare API for pingdotgg/t3code, with no upstream writes. Then record each relevant upstream change below as adopted, already covered or not applicable, and move the pin.

**Last check:** 21 November 2026, from the qualification VM. `main` was 5 commits ahead of the pin, with no change on a watched path and no Antigravity commit; the listing was not truncated.

## Recorded upstream changes

| Upstream | What it does | In Bridge |
| --- | --- | --- |
| [#39485](https://github.com/pingdotgg/t3code/pull/39485) | agy 1.5 keeps Google sign-ins in one shared OS keyring entry for every profile unless it believes it runs over SSH. T3 sets `SSH_CONNECTION` for every Google-account launch, signs in with `agy acp --login` (hosted code page), and verifies with the same profile's ACP session start. | **Adopted.** There is one Bridge-owned profile (`--gemini-dir`) for sign-in, catalog and sessions. The marker is on every launch. Home's sign-in is agy's own `acp --login`, and the URL and reply checks are ported from `antigravityAuthSupport.ts`. Verification is Bridge's sandboxed catalog probe on that profile. |
| [#39989](https://github.com/pingdotgg/t3code/pull/39989) | Keeps a turn open while agy still has a background wake queued (parallel native background commands). | **Not applicable.** Bridge's agent is MCP-only (`tools: []`): agy runs no native background commands or subagents, and every command is a synchronous Codex MCP call. Revisit if native tools are ever allowed. |
| [#39869](https://github.com/pingdotgg/t3code/pull/39869) | A mid-turn Google 404 is shown with its real message and resumed once automatically. | **Partly covered; the resume is not implemented yet (omission).** Bridge shows agy's ACP error message as the turn's error. Upstream found that message generic on the Google-account route, which is Bridge's route, so whether Bridge shows the real 404 text there is unverified. It does not yet resume once after a transient 404, when the model had already replied in that turn. That bounded resume completes the requested turn and is worth adopting. |
| [#40220](https://github.com/pingdotgg/t3code/pull/40220) | Context-usage updates that arrive after a turn ends are saved to the thread. | **Not adopted: a known capability gap.** Bridge does not report context usage for Antigravity turns yet. When it does, it should keep updates that arrive after the turn ends, as this fix does. |

## Known omissions

- **Mid-turn 404 resume:** the bounded one-time resume of #39869 is not implemented.
- **Context usage:** not reported for Antigravity turns (#40220).
- **Thinking levels per model:** agy reports thinking levels only for the selected model. T3 selects each model in turn while reading the catalog; Bridge takes the current model's levels for all of them.

## Deliberate differences from T3

- **No owner customizations:** T3 links the owner's `AGENTS.md`, `GEMINI.md` and `config/skills.json` into its profile. Bridge's profile carries only its own MCP-only agent; skills reach agy through Codex's skill tools.
- **No no-op setting:** T3 still sets `AGY_ACP_FORCE_FILE_STORAGE`, which agy 1.5.13 does not read. Bridge does not.
- **Inside a boundary:** T3 runs agy unsandboxed. Bridge runs sessions and the catalog probe inside its whole-process boundary. Only the sign-in itself runs outside it, and that needs no listener, only Google's endpoints.
