// On demand, for maintainers: what changed in T3 Code's Antigravity harness since the reference pinned in docs/upstream-reference.md.
// Reads GitHub's public compare API through `gh` (the project's own GitHub access); writes nothing, runs nothing from upstream.
// Usage: node scripts/check-upstream.mjs [ref]   (default ref: main). Exit 2 when upstream cannot be read here (no access is assumed).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const doc = readFileSync(new URL('../docs/upstream-reference.md', import.meta.url), 'utf8');
const pin = /\*\*Pinned reference:\*\* `([0-9a-f]{40})`/.exec(doc)?.[1];
const watched = [...doc.slice(doc.indexOf('**Watched paths:**'), doc.indexOf('## Recorded')).matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(p => p.includes('/'));
if (!pin || !watched.length) throw new Error('docs/upstream-reference.md has no pinned reference or watched paths');
const ref = process.argv[2] ?? 'main';
let compare;
try { compare = JSON.parse(execFileSync('gh', ['api', `repos/pingdotgg/t3code/compare/${pin}...${ref}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] })); }
catch (error) {
  console.error(`Could not read github.com/pingdotgg/t3code (${String(error.stderr ?? error.message).split('\n').find(Boolean)?.slice(0, 120)}). It is public: run this where public GitHub reads are allowed.`);
  process.exit(2);
}
const files = (compare.files ?? []).filter(f => watched.some(w => w.endsWith('/') ? f.filename.startsWith(w) : f.filename === w));
const commits = (compare.commits ?? []).map(c => ({ sha: c.sha.slice(0, 10), title: c.commit.message.split('\n')[0] }));
console.log(JSON.stringify({ pinned: pin, ref, aheadBy: compare.ahead_by, truncated: (compare.files ?? []).length >= 300,
  watchedFilesChanged: files.map(f => ({ path: f.filename, status: f.status, changes: f.changes })),
  antigravityCommits: commits.filter(c => /antigravity|agy|acp/i.test(c.title)) }, null, 1));
