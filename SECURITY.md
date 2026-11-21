# Security reports

Report credential exposure, permission bypass or unauthorized session access
through [GitHub private vulnerability reporting](https://github.com/gustavonline/codex-model-bridge/security/advisories/new).
Do not post credentials, raw transcripts or desktop logs in public issues.

The preview supports the current candidate only. The adapter is local and uses
the user's existing Codex and Claude Code permissions. A separate profile is not
an OS sandbox. See [architecture](docs/architecture.md) for actual boundaries
and [operations](docs/operations.md) for diagnosis and recovery.

Initial desktop preparation of the separate window copies Codex/OpenAI `auth.json`,
when present, into the isolated profile with mode 0600 beneath a mode-0700 directory.
It is a one-time credential snapshot, not ongoing auth synchronization. Login/refresh
interaction between separate snapshots is unqualified; do not infer token
independence. From RC13, compatibility checks (`codex-claude check`, the installer
check and the first main-app start) copy nothing from the Codex profile: they use
a fresh synthetic profile in their own temporary directory. Live model tests require
the separate `--copy-codex-auth` opt-in and remove their private temporary copies.
The bridge never reads or copies Claude credentials.

## Release artifacts

After bundling, CI and the draft-release workflow run `scripts/check-artifacts.mjs` on the actual runtime TGZ, plugin ZIP and installer ZIP. That covers every outer entry and the nested runtime archives, within size, entry-count and time bounds.

- **What it refuses:** environment files (`.env`, `.env.*`, `*.env`), auth and credential state, logs, transcripts and history, key files and repository state, wherever they appear and regardless of Git ignore rules.
- **Supported secret formats:** private keys, GitHub, OpenAI, Anthropic, AWS, npm, Google and Slack tokens, secret-variable assignments and private local paths.
- **Allowed exceptions:** only `.env.example`, `.env.sample` and `.env.template`, whose contents are still scanned.
- **What is scanned:** entry names, retained archive metadata (tar header fields and PAX records) and contents. ZIP extra fields and entry comments, gzip header fields, directory payloads and nonzero tar padding are refused.
- **Failure handling:** a failure names the artifact, entry and category, never the matched value; supported formats in entry names are redacted. Unsupported or malformed archives, exceeded bounds and inspection errors also fail.
- **Delivery binding:** a pass records the exact bytes in `dist/ARTIFACT-CHECK.json`. The release step uploads only those files after confirming they are unchanged; a changed, added or missing file, or a missing record, stops it.

This is a packaging control, not a guarantee that no secret can exist in other forms.

Repository settings are separate and are not changed by this source. As read on 22 October 2026:
- `main` requires the strict `checks` status, also for administrators, along with conversation resolution and stale-review dismissal, and disallows force pushes and deletion.
- Repository secret scanning and push protection were disabled.

A passing workflow does not enable them. Confirm the available protections before any public release.

## Session permissions

Session mutations enforce the native approval policy and matching permissions.
Choosing `never` delegates these operations within that boundary; interactive
policies require desktop approval. This does not authenticate natural-language
intent. Shell calls preserve the resolved sandbox, never escalate it, and reject
missing permissions. A new action requiring a bridge approval prompt rejects
unknown policies rather than inheriting a more permissive default. Preapproved
MCP tools keep their separate configured approval rules.

## Harness boundary (Antigravity)

Antigravity runs inside a whole-process boundary: bubblewrap on Linux, and Codex's own sandbox on macOS, which is still in qualification. It works in an empty directory, has no native tools, and reaches the network only through an allowlisting proxy to Google's endpoints. Residual risks:
- **Allowed hosts are a channel.** An exact-domain allowlist does not stop data from leaving through the allowed Google hosts. No proxy sees inside TLS, and code running as agy can read agy's own sign-in in `~/.gemini`.
- **agy's profile is Model Bridge's own.** Bridge runs agy on its own profile, which holds only Bridge's MCP-only agent, so the owner's `~/.gemini` customizations are not loaded.
- **Gemini sign-in runs outside the boundary.** Home's **Sign in with Google** runs agy's own `acp --login` outside the chat boundary, on Model Bridge's own agy profile, in an empty directory, with the environment allowlist and no session, model or tools; it ends with the sign-in. The one-time code the person pastes passes through Home and Bridge's Home process to agy's stdin once and is not stored. Codex may record app tool-call arguments in its own history; the code is single-use and short-lived.
- **The login is a file.** With the remote marker agy keeps the Google sign-in in Model Bridge's profile as a file (0700 directory), readable by code running as agy inside the boundary, instead of the Keychain. The owner's own agy login is separate and untouched.
- **The macOS catalog probe has the local listener.** With Home's Turn on as consent, the probe that lists the account's models runs with the loopback grant, whichever chat asked for the list. It sends no prompt and has no tools.
- **macOS teardown is best effort.** There is no PID namespace. A descendant that detaches itself is killed only if it was seen first.
- **Bridge's MCP tools carry authority.** They act with the chat's own Codex permissions, the same as for a Claude chat.
