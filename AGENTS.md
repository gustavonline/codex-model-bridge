# Codex + Claude contributor instructions

This is Gustav Online’s independent macOS bridge beneath the unmodified Codex desktop UI. Keep it small: Codex owns its native provider, tooling and desktop; the official Claude Code runtime owns Claude execution. No model API proxy, replacement UI, private IPC bypass, credential extraction or signature spoofing.

One writer owns overlapping code. Reviewers read an immutable revision. Use temporary profiles for integration tests; never inject test prompts into existing user chats or include local auth, logs, personal instructions or histories in commits. Preserve the source profile and existing installation state. Stop/restart only when the installed bridge reports idle.

Use npm ci --ignore-scripts --omit=optional and npm test. Keep runtime dependencies pinned in the shipped npm-shrinkwrap.json; after bundling, run npm run test:distribution to check the actual installed tree. Product support and limits belong in README.md and docs; tests must cover behavior, denial, cancellation, recovery and history consistency. Native protocol proof is not desktop visual proof. No new mandatory AIOS/Factory runtime dependency: their workflows guide development only.

The owner has authorized this product’s development, scoped tests, independent Claude review, Gustav Online repository preparation and CI/release packaging. Keep unrelated Factory, AIOS and design projects read-only. Document required work that cannot be tested without the desktop owner.

## Project-selected methods

Notion owns this project's live methods. Provider profiles choose models/accounts;
they carry no personal or project skill collection. The selected catalog is
https://app.notion.com/p/5e1552911ffc42b8a999609cc6847a00 (Agentic System Skills).
Select the Core methods and the Software methods relevant to this task. Before
repository edits, read agentic-new-feature (Software) from
https://app.notion.com/p/41b6d2e17f5681b88400dc157c829d9e. It prepares or reuses
the task branch/worktree and preserves project guidance across checkouts.
Read-only discussion and reviews need no new branch or worktree.

At a new task, or when an update is requested, read the current catalog's names and
descriptions. Select the relevant method from the request, or use the method the
owner names; these methods are not a mandatory sequence. Fetch the selected page
before following its instructions. In this environment the official Notion CLI uses
the project-bound read connection:

    ntn api v1/data_sources/cba59861-cc72-430c-944d-88b2aadae5bf/query --notion-version 2026-03-11 --data '{"page_size":100}'
    ntn api v1/pages/PAGE_ID/markdown --notion-version 2026-03-11

For supporting files, GET v1/ai/skills/PAGE_ID with the same CLI. Download its signed
archive without forwarding the API credential, inspect its paths and read the
needed references. A task cache under the Git-native t3-development directory is
disposable; Notion remains the only editable original. Record the version_id used.
Refresh at the next task/use; handle an instruction change affecting ongoing work
explicitly. Report unavailable live sources rather than silently using old copies.
This connection covers Agentic System only, not personal Data & Context. Additional
method libraries require a selected route and actual connection access.

Project facts, commands and technical artifacts stay in their native sources.
Provider choice and skill choice remain independent.
