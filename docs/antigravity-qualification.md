# Antigravity qualification (20 November)

**Result: not qualified, so Model Bridge does not run it.** An MCP-only Antigravity session is possible natively. But a workspace's own Antigravity hooks run commands outside the Codex sandbox, so no Codex permission boundary holds.

## Setup

- **Runtime:** Google's Antigravity CLI 1.5.13, installed and SHA-512 verified by the coordinator.
- **Sign-in:** the owner's Google sign-in was completed by the coordinator. The probes reused it and never signed in again.
- **Environment:** auto-update off, file credential storage forced, and Google, Gemini, ADC and other provider variables removed.
- **Probes:** one ACP session each, `--process-per-session --disable-telemetry --include-default-customizations=false`.
- **Workspace:** a throwaway directory.
- **Model:** Gemini 3.8 Flash at thinking level low, used for a few short synthetic turns.
- **Tools offered:** Bridge-hosted HTTP MCP tools only.
- **Permission policy:** Bridge allowed its own MCP tool and denied every native request.

This is Linux protocol evidence. It is not macOS desktop evidence. Reproduce the ACP rows with `scripts/qualify-antigravity.mjs --run`. It is an explicit opt-in that reuses an existing login, creates a fresh run directory inside the parent it is given, and never deletes anything. agy itself still records each probe session in the signed-in profile. One synthetic session per probe run remains in this VM's Antigravity profile (`$HOME/.gemini/antigravity-cli/conversations`). They are not removed here, because that profile belongs to the coordinator's login.

The script does not cover two rows: `agy models` and the Codex sandbox row were run by hand with the commands named there. The endpoint facts come from agy's own server log, not from captured traffic.

## Observed

| Question | Observed |
| --- | --- |
| Sign-in and billing route | `authenticate` with `oauth-personal` used the cached login. agy's own server log lists only Code Assist subscription endpoints: `loadCodeAssist`, `fetchAvailableModels`, `generateContent`, `streamGenerateContent`. It lists no Gemini API-key or Vertex endpoint. Traffic was not captured independently. |
| Models | Both `session/new` and `agy models` (run by hand) return what the server's `fetchAvailableModels` reports for this account: Gemini 3.8 Flash at low, medium and high, Claude Sonnet 4.6, Claude Opus 4.6 (Thinking) and GPT-OSS 120B. **Gemini Neon is not offered to this account.** The logs show no tier, so the cause (plan or rollout) is not established. Bridge does not invent it. |
| Default agent: MCP tool | Asks permission. When Bridge allows it, the call reaches Bridge's MCP handler. |
| Default agent: native edit and shell | Both ask permission. When denied, nothing was written or run, inside or outside the workspace. |
| Default agent: read and web search | Neither asks. A workspace file was read, and Google ran the search on its side. |
| Custom main agent with `tools: []` (from `.agents/agents/`) | Only MCP tools plus `manage_task`, `list_resources` and `read_resource` remain. Read, web search and shell are refused by the agent itself. |
| Custom agent naming an MCP tool in `tools` | Fails cleanly at every prompt ("tool not found in registry"); it does not hang. |
| **Workspace `.agents/hooks.json`** (tested at the workspace root, outside any repository) | **Its `SessionStart` and `PreInvocation` commands ran, with no permission request.** This held with default customizations off and with the MCP-only agent. Ancestor `.agents` directories up to a repository root are discovered per the vendor's documentation, but were not tested. |
| Teardown | Closing stdin ended all three processes within about 50–110 ms, with none left. |
| Codex's own sandbox (`codex sandbox -P :read-only` / `:workspace`, run by hand with a throwaway `CODEX_HOME`) | Enforces writes as Codex does, but both profiles also block network. agy's process needs network and writes its state under `~/.gemini`. |
| Profile location | The cached login, conversations and config live under `$HOME/.gemini/` (`antigravity-cli/`, `config/`). `GEMINI_HOME` did not move them; only logs followed `--log-file`. |

## Why this is a refusal

Codex workspaces are routinely written by the model through Codex's own shell. A hooks file in the workspace's `.agents` directory runs on the next session start, or before the next model call, outside Codex's sandbox. Per the vendor's documentation, the same applies to `.agents` directories up to the repository root. Checking for such files beforehand is racy and incomplete.

The minimum boundary is therefore OS containment of agy's whole process tree. It must match the thread's file permissions, keep agy's state directory writable, and allow network only for Google's endpoints. Codex's built-in profiles block all network, and a profile that allows agy's network would also give its hooks network. That boundary has not been built or proven, so Model Bridge keeps Antigravity off and says why in Home.

## Linux whole-process boundary (built after this qualification)

`harness-sandbox.mjs` runs agy in bubblewrap. It mounts only an allowlist:
- `/usr`, `/etc` and their links, agy's own install directory, Node and the relay, all read-only;
- a generated empty working directory, read-only (the chat's workspace is not mounted; agy reaches it only through Codex's tools);
- agy's own state (`~/.gemini`), writable;
- a private `/tmp`.

The sandbox root is remounted read-only. There is no network but a Bridge proxy that admits CONNECT to `daily-cloudcode-pa.googleapis.com` and `oauth2.googleapis.com` only, and Bridge's MCP endpoint. A private PID namespace ends every child with the sandbox.

Re-measured with the existing login (`scripts/live-antigravity.mjs`, and `qualify-antigravity.mjs` with `PROBE_SANDBOX=1` and a hostile `SessionStart` hook):
- The hook ran. It could not write the workspace. It could not reach `example.com`, the host's Docker socket, another tool's credential directory or `/run`.
- agy itself signed in, listed this account's models, made the Bridge MCP call, cancelled within 8 ms and was torn down with nothing left.
- agy also tried `www.googleapis.com` and `aicode.googleapis.com`. Both were refused without breaking a turn.

An earlier version bound the whole root read-only. A review measured that host Unix sockets stayed reachable, so the mount set is now an allowlist. Tests now check that host sockets and foreign credential files are unreachable.

Since then:
- The adapter is wired into chat routing; see [harnesses](harnesses.md).
- agy works in a generated empty directory, so workspace customizations never load.
- macOS uses Codex's own sandbox. Native Mac proofs: the boundary canary, the stdio relay over the exact socket with the network proxy active, and agy booting. Until a live Mac turn passes, macOS is offered only with the qualification switch `BRIDGE_ANTIGRAVITY_MAC=1`.

**macOS local listener.** agy starts its own language server on `127.0.0.1`. Under Codex's sandbox that requires `allow_local_binding`, which the coordinator measured also opens raw loopback to every local service. So on macOS a Gemini turn runs only in a chat whose native-confirmed sandbox is full access (`dangerFullAccess`), where the chat's own Codex shell already reaches those services. Any other chat is refused, and Bridge never widens it.

The account's model list is read by a short probe that belongs to no chat: it gets no prompt and no tools, but on macOS it needs the same local-listener grant. Any chat's model list can start it. It runs only with the consent recorded by Home's Turn on, and never before that, not even the boundary canary.

**Sign-in (agy 1.5.13, measured with throwaway profiles, nothing completed).**
- **`agy acp --login`:** sends Google back to `https://antigravity.google/oauth-callback` and asks for the code to be pasted, with or without a terminal. Home's sign-in does not offer it yet; the qualification step `login` runs it inside the boundary.
- **ACP `authenticate` (`oauth-personal`) on a signed-out profile that may open a browser:** agy calls the system opener with an authorization that returns to `http://localhost:<port>/auth/callback`, its own listener. No paste is involved. This is Home's sign-in.
- **The same call with the remote marker (`SSH_CONNECTION`):** refused at once with "No browser is available here". Every session and catalog probe sets that marker.
- **File-storage login:** lives at `~/.gemini/antigravity-cli/antigravity-oauth-token`, but only where agy has no OS keyring (headless Linux). On macOS agy uses the Keychain. Home reports only whether the file exists, and never reads it.
- **Profile directory:** agy's `--gemini-dir <abs>` moves its state and login. A fresh directory is signed out while the default profile is signed in (Linux, measured).

These sign-in rows are Linux measurements.

**Resolved (T3 Code #39485, docs/upstream-reference.md):** with the remote marker, agy keeps a Google sign-in in the profile's own file storage, not in the OS keyring entry it otherwise shares across every profile. Bridge therefore signs in with `agy acp --login` on its own `--gemini-dir`, with the marker, and verifies with a sandboxed catalog probe on that profile. The A1/A2 Mac result (the ACP `authenticate` loopback route reaching its listener inside Codex's sandbox) proves the URL and listener only, not isolated credentials, and is no longer the route.

**Earlier qualification steps (kept for diagnosis).** `scripts/qualify-antigravity-auth.mjs` runs the deciding checks without any prompt or model call:
- **`a`:** agy's sign-in starts inside the boundary on a Bridge-owned `--gemini-dir`; the authorization URL is captured and checked, and the host probes agy's callback. With `--wait`, the person completes the sign-in and the new profile files are listed, by name and size only.
- **`a4`:** a fresh sandboxed launch on that profile authenticates and lists the catalog.
- **`c1` and `c4`:** the same outside the boundary, on the owner's login and on a fresh profile.

On Linux (bubblewrap):
- `a` captures a valid `localhost` authorization inside the boundary.
- The host cannot reach agy's listener in bubblewrap's private network, so on Linux the sign-in stays outside the boundary.
- `a4` on a fresh profile is signed out.
- `c1` lists 6 models on the owner's login.
- `c4` is signed out (the login is keyed per profile).

- **`login`:** agy's own `acp --login` runs inside the boundary on the Bridge profile. Its Google page is hosted, so no local listener is needed. The person pastes agy's one-time code in the terminal; it goes straight to agy's stdin and is not written anywhere by the script, though the terminal echoes it into its own scrollback. Then `a4` reads the login back.

On macOS these steps decide between two routes:
- a Bridge-owned profile signed in inside Codex's sandbox, where agy's Keychain write is **expected** (not yet measured) to fail and fall back to its file storage;
- running agy outside the sandbox in full-access chats.

Still not done:
- a live macOS Gemini turn: no sandboxed session on the Mac has a usable login yet (agy's Mac login is in the Keychain);
- Home's sign-in has never completed end to end with a real Google account; on macOS neither the opener interception nor where the login is stored has been proven;
- approval mapping per Codex sandbox and approval combination is not tested.

## What would change this

- An official agy option that disables workspace hooks and other executable customizations for a session, verified natively.
- Or a proven OS boundary around the agy process tree with the properties above, plus an approval mapping test against Codex for each sandbox and approval combination.
- A Bridge-owned Antigravity profile (`--gemini-dir`) with its own sign-in, so the agent definition and config never live in a user workspace or in the person's own `~/.gemini`. This needs a fresh owner sign-in through the proper flow.
