import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROLES = ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'];
const READ_ONLY = ['reviewer', 'qa', 'investigator'];
const load = (r: string) => JSON.parse(readFileSync(new URL(`../kit/permissions/${r}.json`, import.meta.url), 'utf8'));

// Approximates Claude Code's Bash matching: `*` = any run of characters; a trailing " *" also matches the bare command.
// The real proof is the live check at release.
function matches(rule: string, cmd: string): boolean {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const pat = m[1]!;
  const re = (p: string) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re(pat).test(cmd) || (pat.endsWith(' *') && pat.split('*').length === 2 && re(pat.slice(0, -2)).test(cmd));
}
const denied = (deny: string[], cmd: string) => deny.some((r) => matches(r, cmd));

test('every role has a permission file that parses, with no defaultMode', () => {
  for (const r of ROLES) {
    const f = load(r);
    assert.ok(Array.isArray(f.permissions.deny) && Array.isArray(f.permissions.allow), r);
    assert.equal('defaultMode' in f.permissions, false, r);
    assert.ok(f.permissions.allow.includes('Bash(cb *)'), r);
  }
});

test('every role denies push to main/master in every spelling, and force pushes', () => {
  const bad = [
    'git push', 'git push origin', 'git push origin main', 'git push origin main --tags', 'git push -u origin main',
    'git push origin HEAD:main', 'git push origin HEAD:main -v', 'git push origin +main', 'git push origin +fix/x',
    'git push origin master', 'git push origin HEAD:master', 'git push -f', 'git push -f origin fix/x',
    'git push origin fix/x -f', 'git push --force', 'git push origin fix/x --force', 'git push --force-with-lease',
    'git push origin fix/x --force-with-lease',
    'git -C ../wt push origin main', 'git -C x push origin HEAD:main', 'git -c x=y push origin main',
    'git push origin refs/heads/main', 'git push origin HEAD:refs/heads/main', 'git -C wt push --force origin x',
    'git -C wt push origin +x', 'git -C wt push -f origin x',
  ];
  for (const r of ROLES) {
    const { deny } = load(r).permissions;
    assert.ok(deny.includes('Bash(git push * main)') && deny.includes('Bash(git push *--force*)'), r);
    for (const c of bad) assert.ok(denied(deny, c), `${r} must deny: ${c}`);
  }
});

test('a branch named fix/maintenance and an ordinary feature push match no deny rule', () => {
  for (const r of ROLES.filter((x) => !READ_ONLY.includes(x))) {
    const { deny } = load(r).permissions;
    for (const c of ['git push origin fix/maintenance', 'git push -u origin feat/3599-kit', 'git push origin HEAD:feat/x',
      'git push origin feat/main-menu', 'git -C wt push origin fix/maintenance', 'git -C wt push -u origin feat/main-menu',
      'git -C wt push origin feat/x', 'git commit -m "push to main"']) {
      assert.deepEqual(deny.filter((d: string) => matches(d, c)), [], `${r}: ${c}`);
    }
  }
});

test('reviewer, qa and investigator cannot edit, commit or push', () => {
  for (const r of READ_ONLY) {
    const { deny } = load(r).permissions;
    for (const t of ['Edit', 'Write', 'NotebookEdit', 'Bash(git commit*)', 'Bash(git push*)']) assert.ok(deny.includes(t), `${r}: ${t}`);
    assert.ok(denied(deny, 'git commit -m x') && denied(deny, 'git push origin fix/x'), r);
  }
  for (const r of ROLES.filter((x) => !READ_ONLY.includes(x))) {
    const { deny } = load(r).permissions;
    assert.equal(deny.includes('Edit') || deny.includes('Write'), false, r);
  }
});

test('only the lead may merge pull requests', () => {
  for (const r of ROLES) {
    const { deny, allow } = load(r).permissions;
    if (r === 'lead') {
      assert.ok(allow.includes('Bash(gh pr merge*)') && !deny.includes('Bash(gh pr merge*)'));
    } else {
      assert.ok(deny.includes('Bash(gh pr merge*)') && !allow.includes('Bash(gh pr merge*)'), r);
      assert.ok(denied(deny, 'gh pr merge 12 --squash'), r);
    }
  }
});
