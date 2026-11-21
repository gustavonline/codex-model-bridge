# Harnesses

Model Bridge sits beneath the unmodified Codex desktop. A **harness** is the runtime that executes a chat's turns. Codex stays the tool, sandbox and approval host for every harness that runs here.

| Harness | Transport | Runs in Bridge | Why |
| --- | --- | --- | --- |
| Codex | Codex app-server (native) | Yes | Native; Bridge does not change it. |
| Claude Code | `@anthropic-ai/claude-agent-sdk` 0.3.325 | Yes | No native tools: every action goes through the Codex MCP tools, so Codex's sandbox and approvals apply. |
| Custom Responses endpoints | Codex app-server with a Bridge provider | Yes, in the isolated preview | Native Codex execution against the saved endpoint; see the README for the preview's limits. |
| Gemini (Antigravity) | ACP, `agy acp` (1.5.0 or newer) | Linux: yes, once turned on in Home. macOS: candidate, off unless a qualification run sets `BRIDGE_ANTIGRAVITY_MAC=1`, and then only in full-access chats | It runs inside Model Bridge's process boundary with only the Codex tools Bridge supplies, because a workspace's own Antigravity hooks would otherwise run commands outside the Codex sandbox. On macOS agy's own local listener needs a grant that opens loopback, so it runs only where the chat already has full access. See [the qualification](antigravity-qualification.md). |
| Cursor | `@cursor/sdk` | No | The SDK reports no command or file approval support. |
| Muse Code | `@muse-code/sdk` | No | Not qualified. |
| Grok, fx, Kiro | ACP | No | ACP agents with their own tools; not qualified. |
| ACP registry agents | ACP | No | Each brings its own tools; not qualified. |
| Pi | Pi RPC | No | Not qualified. |
| OpenCode | `@opencode-ai/sdk` over HTTP | No | Runs its own tools and server; not qualified. |

The non-running routes are the ones pinned T3 Code (`pingdotgg/t3code` `df09ced`, MIT) uses. The connection manager Home (the provider-bound Home; the default diagnostic Home has no connection list) shows them under **Connect more**, each with what is actually known:

- whether the runtime was found on `PATH` or in the usual install folders, and its minimum version. It is never run, so a found runtime is not "ready".
- that sign-in and models are not checked;
- that it is not available in Bridge, and why.

Home offers no action for them, and Bridge never puts them in the model picker.

## Route identity

A route is *(harness, connection, model)*. A model of a non-native harness is always named `bridge-harness/<harness>/<connection>/<model>`. Antigravity, for example, can serve `claude-*` and GPT models. Under this naming those models can never be taken for Claude Code or Codex models.

`thread/start`, `thread/resume`, `thread/fork`, `thread/settings/update` and `turn/start` refuse a `bridge-harness/…` model before any host or SDK sees it. The check covers both `model` and the collaboration mode's model, and the prefix in any letter case.

An Antigravity route executes only where Antigravity is qualified and turned on: a new chat on one of its models, or a request on that chat that names its own model. Every other harness route is refused. An Antigravity chat refuses any other model on every model-carrying request, so a router never reads it as a switch. Claude Code and Codex are still chosen by model family, and bare Claude names (`opus`, `sonnet`, `haiku`, `claude-*`) keep resolving to Claude Code. A further harness still needs the adapter refactor the architecture reviews asked for.

## Turning a harness on

In the connection-manager Home, the Gemini (Antigravity) row in **Connect more** offers **Turn on** where its boundary is supported and `agy` is found. The choice and the resolved runtime path are stored in Bridge's own connection store (`harnesses.json`).

Once it is on, Gemini appears as a connected provider, like Claude:
- Its account's models enter the same model library and slots as every other model. They are never shown by default: add them to the picker like any other model, and an unselected one stays hidden in the native model list.
- While it is off, or its catalog is not loaded, a saved selection stays in the library as unavailable, is not offered, and is never rewritten.
- **Turn off** stops new chats at once; existing chats keep their history and still open, and a turn in one is refused with the reason until it is turned on again.

### Signing in with Google

**Status: proven on Linux only. The macOS route is open and not offered as working.**

The Gemini card and row in Home offer **Sign in with Google** wherever agy is found and its boundary is supported. It runs agy's own sign-in, ACP `authenticate` with the Google-account method:
- **Browser:** agy prepares Google's authorization and Home opens it with the host's own link opening (**Open browser**).
- **Return:** Google returns to agy's own `localhost` callback, so there is no code to copy or paste. Bridge never sees a code, token or password.
- **Refusal:** Home opens only a Google PKCE authorization that returns to `localhost`. If agy offers its paste-code page instead, the sign-in is refused.
- **Opener coverage:** the recorder covers agy calling `open`, `xdg-open`, `sensible-browser` or `$BROWSER`. An opener called by absolute path would open the real browser directly, without Home's check.
- **Where it runs:** outside the chat boundary, because the browser's redirect has to reach agy's listener. It runs in an empty directory with the usual environment allowlist, creates no session, runs no model and gets no tools; see SECURITY.md.

Where agy keeps the login decides whether the sandboxed sessions can use it. agy 1.5.13 uses the OS keyring, and its own file storage only where there is no keyring, as on a headless Linux host. It has no setting that forces file storage: `AGY_ACP_FORCE_FILE_STORAGE` does not exist in its binary, and Bridge no longer sets it.
- **Linux without a keyring:** the login is a file that the sandboxed sessions read. This is how the qualification VM works.
- **macOS:** the login goes to the Keychain, which Codex's sandbox cannot reach. Measured on the Mac at f153b67: Home's sign-in reported success at once without a browser (it reused the owner's existing Keychain login), and no file was written. A sandboxed session there is signed out. The route that gives sandboxed sessions a usable login, without exporting from the Keychain or signing the owner out, is still being decided.

Home shows whether a file-storage login is saved. A saved login is not proof that Google still accepts it. A chat on a signed-out profile fails at once as `unauthorized`, with the Home sign-in step, because every session carries the marker that stops agy from opening a browser. Before that marker, a sandboxed turn on the Mac waited on a browser sign-in until its 120 s bound.

`BRIDGE_AGY` exists for development only.

## Bridge chats in the chat list

Native `thread/list` lists only threads that have a native user turn. A Claude or Gemini chat's host thread has none, because its model never runs there, so native's own listing never includes it. This was measured on 0.166.0 and 0.171.0-alpha.13 with throwaway profiles: no filter returns such a thread, not even `includedThreadIds`, before or after a restart.

Bridge therefore answers `thread/list` with native's rows plus its own Claude and Gemini chats that have at least one turn:
- **Filters:** archived, cwd, provider, source kind, title search, included and excluded IDs, project and section.
- **Order and paging:** Bridge sorts by the requested key and pages with its own cursors. With no such chat, the listing is native's own paging, unchanged.
- **Not covered:** `thread/search` does not find Bridge's chats. Ancestry and attachment filters leave them out, and a `section_position` sort keeps native's order only.

## Child chats and the mailbox

A Codex chat that has Bridge's `codex_bridge_sessions` tools can create a chat on another runtime with `manage create`. That works from a GPT-first chat, and `read models` lists what is available.
- **Same boundaries:** the child gets the caller's workspace and permissions, and exactly the caller's desktop tools as the desktop gave them. If Bridge did not see them, it says so.
- **Child to parent:** the child answers with `mailbox report`, sending a question, progress or a result. Messages are deduplicated by requestId, bounded and untrusted.
- **Parent to child:** the parent's `read wait` returns as soon as the child reports or finishes. Its next turn carries an untrusted pointer to unread messages. Nothing starts, steers or wakes a turn by itself, and creation is capped at two levels.
- **Shared core:** Claude Code and Antigravity children use the same tools, mailbox and permission checks.

Evidence (Linux, `scripts/live-orchestration.mjs`, the real Codex app-server on this machine's own login):
- A `gpt-6-luna` chat at low effort created a Gemini 3.8 Flash child, waited, read its mailbox question, replied, and read the answer.
- That run used 2 GPT turns and 2 Gemini turns.

Not yet observed on a Mac:
- whether the desktop renders the created chat;
- whether its desktop tools work for a thread the desktop did not start;
- whether a browser page then opens visibly.

## Claude Code lifecycle

- Each turn's SDK query spawns its CLI through the SDK's public `spawnClaudeCodeProcess` hook, so Bridge owns the process.
- A chat is released only after that process has exited. Bridge waits 5 s, then kills the process and waits up to 2 s more. That covers the next queued turn, an immediate resend after Stop, and the history checkpoint, so none of them overlaps the previous process on the same session. The exception is a child that is still not confirmed gone after the kill: Bridge logs `turn.child_exit unconfirmed` and continues.
- Stop completes when the process has exited. Measured live, that takes 1.9–2.1 s mid-stream (four samples). It is the SDK's own graceful close: stdin ends, then SIGTERM after about 2 s. Bridge keeps this window so the CLI finishes writing the session that the next turn resumes.
- Until then nothing can start or steer the chat. `turn/start` is refused as still running, while `turn/steer` and `thread/queue/start` are refused as no longer active. A message can still be queued. It is not started when the interrupted turn ends; it runs once, after the next completed turn. A partial wait for `turn/start` only was tried and removed, because it made these inconsistent. How the unmodified desktop shows this window is not yet observed on a Mac.
- A failed CLI's last stderr lines (bounded) are appended to the turn error, as the SDK does for its own spawn. Bridge reads them after the stream has closed, waiting at most 0.5 s.
- A CLI that sends no first message within 60 s (`BRIDGE_CLAUDE_BOOT_MS`) fails the turn with a clear error instead of holding it. The model-list probe has the same bound. Its child is reaped in the background, and the list is not held until it exits.
- Bridge keeps one query per turn and does not keep live queries between turns. The measurements below show why.

## Measurements (Linux VM, not desktop)

`scripts/benchmark-claude.mjs --run --rounds 4` measures live inference. It uses Claude Code 2.1.306, Haiku, SDK 0.3.325 (as shipped), no tools, and an identical prompt and settings in both modes. Each mode's first turn starts a fresh child (cold); the other three are warm. Times are in milliseconds from the moment the turn is asked.

| Mode | Init, cold / warm | First text, cold / warm | Process tree RSS |
| --- | --- | --- | --- |
| Query per turn (Bridge) | 932 / 612–642 | 2411 / 2089–2318 | about 265 MiB while a turn runs, none between turns |
| Persistent live query (T3 pattern) | 590 / 12–21 | 2272 / 1901–1935 | 233 MiB idle per kept chat, 310 MiB peak |

- **Stop to exit, mid-stream:** 1875–2096 ms.
- **Model list:** 546–558 ms; the probe child then exits 0.4–0.5 s after close. This involves no inference.
- **Close to exit after a finished turn:** 399–438 ms.
- **Prompt join on both SDKs:** the `user_message_uuid`/`user_message_uuids` join is present on assistant and `message_start` frames.

Earlier two- and three-round runs, on SDK 0.3.296 and 0.3.325, gave the same picture with more spread. On 0.3.325, one warm persistent-query sample was slower than the per-turn ones.

A persistent query saves about 0.6 s of CLI start per warm turn, and here 0.2–0.4 s of first text. Each kept chat costs about 233 MiB while idle on a 4 GiB VM. Reusing a query would also need the per-turn MCP server and system prompt moved out of the turn, plus a reuse key covering permissions and tools. Bridge therefore keeps one query per turn.

Not measured: the macOS desktop, Codex MCP tool calls, long histories, and T3 Code itself on the same machine. No parity with T3 is claimed.

## Known limits

- Antigravity was first qualified on 20 November and refused, because a workspace's own hooks run outside Codex's sandbox. It now runs inside a whole-process boundary with an MCP-only agent, in a generated empty directory, and is wired into chat routing, Home and the slots; see [the qualification](antigravity-qualification.md). Gemini Neon is not in this account's server catalog, which matches the owner-reported free plan.
- On macOS the boundary is Codex's own sandbox. It is a candidate until a native Mac run passes: Home lists it as not qualified, and nothing runs, unless the qualification switch `BRIDGE_ANTIGRAVITY_MAC=1` is set.
- `antigravityLaunch()` prepares the Google-account route. It turns auto-update off, moves only the server log, passes only an allowlist of the environment (dropping every `GEMINI_*`, `GOOGLE_*`, `CLOUDSDK_*` and Vertex variable), and does not pass `--sandbox`. It does not isolate the profile: on 1.5.13 the login and state stay under `$HOME/.gemini`, and `GEMINI_HOME` moves nothing.
- Turning Antigravity off in Home takes effect at once: its models leave the list and a new chat on one is refused, though a catalog is still cached.
- Stop, or the loss of full access on a Mac, also ends agy's start: its whole tree is closed and nothing is sent.
- A resume timeout (rather than agy refusing the session) keeps the session and is retried on the next turn. Read mailbox messages stay on disk with the chat's state.
- Native Mac desktop behaviour after these changes needs the desktop owner's run.
