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

// Board messages (answers, tells, next-work pushes) reach a squad session through its relay; Claude Code holds them
// as "unidentified session" messages unless crossSessionInbound is accept (found in the 3601 live check, Q2390).
test('every role accepts board messages from its relay', () => {
  for (const r of ROLES) assert.equal(load(r).crossSessionInbound, 'accept', r);
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
  // Azure DevOps (#3746): completing a PR merges it, and so do auto-complete and bypass-policy, on create as on update.
  // Title, description and reviewer edits, and a plain create, stay open to every role.
  const AZ = ['Bash(az repos pr update*complete*)', 'Bash(az repos pr create*complete*)',
    'Bash(az repos pr create*bypass-policy*)', 'Bash(az repos pr update*bypass-policy*)'];
  const azMerge = ['az repos pr update --id 12 --status completed', 'az repos pr update --status completed --id 12',
    'az repos pr update --id 12 --auto-complete true',
    'az repos pr create --source-branch x --target-branch y --auto-complete true',
    'az repos pr create --repository api --source-branch x --target-branch y --bypass-policy true --bypass-policy-reason r',
    'az repos pr update --id 7 --bypass-policy true'];
  const azFine = ['az repos pr update --id 12 --title "Fix parser"', 'az repos pr update --id 12 --description x',
    'az repos pr show --id 12', 'az repos pr create --repository api --source-branch feat/x --target-branch main'];
  for (const r of ROLES) {
    const { deny, allow } = load(r).permissions;
    if (r === 'lead') {
      assert.ok(allow.includes('Bash(gh pr merge*)') && !deny.includes('Bash(gh pr merge*)'));
      assert.ok(allow.includes('Bash(az repos pr update*)') && allow.includes('Bash(az repos pr create*)'));
      assert.ok(!deny.some((d: string) => d.startsWith('Bash(az ')));
      for (const c of azMerge) assert.equal(denied(deny, c), false, `lead must not deny: ${c}`);
    } else {
      assert.ok(deny.includes('Bash(gh pr merge*)') && !allow.includes('Bash(gh pr merge*)'), r);
      assert.ok(denied(deny, 'gh pr merge 12 --squash'), r);
      for (const d of AZ) assert.ok(deny.includes(d), `${r} must list: ${d}`);
      assert.ok(!allow.some((a: string) => a.startsWith('Bash(az ')), r);
      for (const c of azMerge) assert.ok(denied(deny, c), `${r} must deny: ${c}`);
      for (const c of azFine) assert.equal(denied(deny, c), false, `${r} must allow: ${c}`);
    }
  }
});

test('every role denies the other push spellings: mirror, all, HEAD or @ as the ref, and pushes that name no branch', () => {
  const bad = [
    'git push --mirror', 'git push origin --mirror', 'git push --all', 'git push origin --all', 'git push origin --all --tags',
    'git push origin HEAD', 'git push -u origin HEAD', 'git push origin HEAD --tags', 'git push origin @', 'git push origin @ -v',
    'git push upstream', 'git push -u', 'git push -u origin',
    'git -C wt push --mirror', 'git -C wt push origin --all', 'git -C wt push origin HEAD', 'git -C wt push -u origin HEAD', 'git -C wt push origin @',
    'git -C wt push', 'git -C wt push origin', 'git -C wt push upstream', 'git -C wt push -u', 'git -C wt push -u origin',
  ];
  for (const r of ROLES) {
    const { deny } = load(r).permissions;
    for (const c of bad) assert.ok(denied(deny, c), `${r} must deny: ${c}`);
  }
});

test('a named-branch push stays allowed for the roles that may push', () => {
  for (const r of ROLES.filter((x) => !READ_ONLY.includes(x))) {
    const { deny } = load(r).permissions;
    for (const c of ['git push -u origin feat/x', 'git push origin feat/x', 'git -C wt push -u origin feat/x', 'git -C wt push origin feat/x',
      'git push origin HEAD:feat/x', 'git push origin feat/HEAD-fix', 'git push origin feat/all-in-one']) {
      assert.deepEqual(deny.filter((d: string) => matches(d, c)), [], `${r}: ${c}`);
    }
  }
});

test('read-only roles also deny commit with git options in front', () => {
  for (const r of READ_ONLY) {
    const { deny } = load(r).permissions;
    assert.ok(deny.includes('Bash(git -* commit*)'), r);
    assert.ok(denied(deny, 'git -C wt commit -m x') && denied(deny, 'git -c user.name=x commit -m y'), r);
    assert.equal(denied(deny, 'git cat-file commit HEAD'), false, r);
  }
});

test('push options that name no branch are denied, with twins; the git -* twins spare other subcommands', () => {
  const bad = ['git push --no-verify', 'git push origin --no-verify', 'git push -u origin --no-verify', 'git push origin -u',
    'git push --set-upstream origin', 'git push origin --set-upstream', 'git push -u upstream', 'git push -v', 'git push -q',
    'git push --follow-tags', 'git push --atomic origin', 'git -C wt push --no-verify', 'git -C wt push origin main',
    'git -C wt push origin -u', 'git -C wt push -v', 'git -c k=v push --atomic origin'];
  const fine = ['git stash push -u', 'git log --grep push', 'git push -u origin feat/x'];
  for (const r of ROLES) {
    const { deny } = load(r).permissions;
    for (const c of bad) assert.ok(denied(deny, c), `${r} must deny: ${c}`);
    for (const c of fine.filter((x) => !(READ_ONLY.includes(r) && x.startsWith('git push')))) assert.equal(denied(deny, c), false, `${r} must allow: ${c}`);
  }
});

// #4346: the guard sees only Bash/PowerShell, so an MCP tool (a mail send, a SQL execute, a drive share...) was open
// to any seat acting on an injected [GitHub · untrusted] line. No role's work uses MCP. Under bypassPermissions allow
// rules do nothing and deny rules always hold, so the fence is a deny: mcp__* covers every server and also takes the
// tools out of the session's context; disableClaudeAiConnectors stops the account's claude.ai connectors loading.
// A role that one day needs a server gets a narrower deny, never an allow (it would be ignored).
test('every role denies every MCP tool and loads no claude.ai connectors', () => {
  for (const r of ROLES) {
    const f = load(r);
    assert.ok(f.permissions.deny.includes('mcp__*'), `${r}: mcp__*`);
    assert.equal(f.disableClaudeAiConnectors, true, `${r}: disableClaudeAiConnectors`);
    assert.equal(f.permissions.allow.some((a: string) => a.startsWith('mcp__')), false, `${r}: an MCP allow does nothing under bypass`);
  }
});

test('no role may use the PowerShell tool: squad sessions work through Bash', () => {
  for (const r of ROLES) assert.ok(load(r).permissions.deny.includes('PowerShell'), r);
});
