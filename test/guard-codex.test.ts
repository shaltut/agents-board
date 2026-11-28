// The Codex PreToolUse shim (#4002 phase 2): allow, block, malformed input, unknown tool, role blocks, exact output format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deny, parseCodexInput, runCodexShim } from '../kit/guard/shim-codex.mjs';

const GUARD = fileURLToPath(new URL('../kit/guard/', import.meta.url));
const SHIM = join(GUARD, 'shim-codex.mjs');
const CB_ENV = ['CB_ROLE', 'CB_AGENT', 'CB_PROTECTED_BRANCHES', 'CB_ALLOW_ASK'];
function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (CB_ENV.includes(k.toUpperCase())) delete env[k];
  return { ...env, ...extra };
}
// One real hook run: exit 0, and stdout is the whole answer (an empty stdout would be an allow, so JSON.parse failing fails the test)
function run(input: string, env: Record<string, string> = {}, file = SHIM) {
  const r = spawnSync(process.execPath, [file], { input, encoding: 'utf8', env: cleanEnv(env) });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  return { stdout: r.stdout, out: JSON.parse(r.stdout) };
}
const call = (tool_name: string, tool_input: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 's', turn_id: 't', hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'u', ...extra });
const bash = (command: string) => call('Bash', { command });
const denial = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

test('allow prints exactly {} (Codex rejects an explicit permissionDecision:allow)', () => {
  assert.equal(run(bash('ls -la')).stdout, '{}');
  assert.equal(run(bash('git push origin feat/x'), { CB_ROLE: 'builder' }).stdout, '{}');
  assert.equal(run(call('apply_patch', { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' }), { CB_ROLE: 'builder' }).stdout, '{}');
  assert.equal(run(call('apply_patch', {})).stdout, '{}'); // no role: only the base rules
});

test('a dangerous command blocks with the exact Codex deny object', () => {
  const r = run(bash('git reset --hard'));
  assert.deepEqual(r.out, denial('Blocked dangerous command: git reset --hard'));
  assert.deepEqual(Object.keys(r.out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(r.out.hookSpecificOutput), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
  assert.equal(deny('x').hookSpecificOutput.permissionDecisionReason, 'x');
});

test('PowerShell tool name reads as shell too; a protected-branch push blocks from CB_PROTECTED_BRANCHES', () => {
  assert.equal(run(call('PowerShell', { command: 'Remove-Item -Recurse -Force C:\\' })).out.hookSpecificOutput.permissionDecision, 'deny');
  const r = run(bash('git push origin develop'), { CB_PROTECTED_BRANCHES: 'develop,release' });
  assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /^Blocked dangerous command: /);
});

test('role blocks: a builder cannot push to main or merge; a reviewer cannot commit, push or patch', () => {
  const b = run(bash('git push origin main'), { CB_ROLE: 'builder' }).out.hookSpecificOutput;
  assert.equal(b.permissionDecision, 'deny');
  assert.match(b.permissionDecisionReason, /^Blocked (?:dangerous command|by role \(builder\)): /);
  assert.match(run(bash('gh pr merge 12'), { CB_ROLE: 'builder' }).out.hookSpecificOutput.permissionDecisionReason, /^Blocked by role \(builder\): /);
  // #4638: an alias, commit plumbing and a gh api merge are judged in the Codex seat the same way
  assert.match(run(bash('gh api -X PUT repos/o/r/pulls/5/merge'), { CB_ROLE: 'builder' }).out.hookSpecificOutput.permissionDecisionReason, /^Blocked by role \(builder\): /);
  assert.match(run(bash('S=push; git $S origin main'), { CB_ROLE: 'lead' }).out.hookSpecificOutput.permissionDecisionReason, /^Blocked by role \(lead\): /);
  for (const cmd of ['git commit -m x', 'git push origin feat/x', 'git -c alias.c=commit c -m x', 'git commit-tree HEAD^{tree} -m x',
    'git update-ref refs/heads/x HEAD', 'gh api -X PUT repos/o/r/pulls/5/merge',
    // #4661
    'git subtree push -P x origin feat/x', 'GIT_EXEC_PATH=/tmp/evil git status', 'gh merge 5']) {
    for (const role of ['reviewer', 'qa', 'investigator']) {
      assert.match(run(bash(cmd), { CB_ROLE: role }).out.hookSpecificOutput.permissionDecisionReason, new RegExp(`^Blocked by role \\(${role}\\): `), `${role} ${cmd}`);
    }
  }
  const edit = run(call('apply_patch', { command: '*** Begin Patch' }), { CB_ROLE: 'reviewer' }).out.hookSpecificOutput;
  assert.equal(edit.permissionDecision, 'deny');
  assert.match(edit.permissionDecisionReason, /^Blocked by role \(reviewer\): editing files/);
  assert.equal(run(bash('git log --oneline'), { CB_ROLE: 'reviewer' }).stdout, '{}');
});

test('in a seat, request_user_input is denied unless CB_ALLOW_ASK=1, with the cb ask pointer', () => {
  const r = run(call('request_user_input', { questions: [] }), { CB_ROLE: 'builder' }).out.hookSpecificOutput;
  assert.equal(r.permissionDecision, 'deny');
  assert.match(r.permissionDecisionReason, /cb ask/);
  assert.equal(run(call('request_user_input', { questions: [] }), { CB_ROLE: 'builder', CB_ALLOW_ASK: '1' }).stdout, '{}');
});

test('an unknown CB_ROLE blocks', () => {
  const r = run(bash('ls'), { CB_ROLE: 'wizard' }).out.hookSpecificOutput;
  assert.equal(r.permissionDecision, 'deny');
  assert.match(r.permissionDecisionReason, /unknown CB_ROLE/);
});

test('fail closed on unreadable input: every case is a deny object, exit 0', () => {
  for (const input of ['', '   ', 'not json', 'null', '[]', '5', '{}', '{"tool_name":"Bash"}', '{"tool_name":"Bash","tool_input":{}}',
    '{"tool_name":"Bash","tool_input":{"command":["ls"]}}', '{"tool_name":"Bash","tool_input":[]}', '{"tool_name":"Bash","tool_input":"ls"}']) {
    const r = run(input).out.hookSpecificOutput;
    assert.equal(r.permissionDecision, 'deny', JSON.stringify(input));
    assert.match(r.permissionDecisionReason, /^Blocked: guard could not read hook input/, JSON.stringify(input));
  }
});

test('in a seat, unknown tools block, including a missing tool_name and an MCP tool; the Claude-style omitted tool_name is not accepted', () => {
  for (const input of [call('', { command: 'ls' }), call('mcp__postman__run', { command: 'ls' }), call('bash', { command: 'ls' }), call('UnknownTool', {}),
    JSON.stringify({ tool_input: { command: 'ls' } }), JSON.stringify({ tool_name: null, tool_input: { command: 'ls' } }), JSON.stringify({ tool_name: 5, tool_input: { command: 'ls' } })]) {
    for (const env of [{ CB_ROLE: 'builder' }, { CB_ROLE: 'reviewer' }]) {
      const r = run(input, env).out.hookSpecificOutput;
      assert.equal(r.permissionDecision, 'deny', input);
      assert.match(r.permissionDecisionReason, /^Blocked: unrecognized tool/, input);
    }
  }
});

// PR 96 review r2 ruling on I3: outside a seat Codex gets exactly what Claude gets there: its other tools pass (Claude's
// never reach the guard), shell commands get the dangerous-command rules only, and a question follows CB_ALLOW_ASK
test('outside a seat (the hook is machine-wide) the owner\'s own Codex gets what Claude gets there (PR 96 review I3, r2 ruling)', () => {
  for (const [name, input] of [['update_plan', { plan: [] }], ['view_image', { path: 'a.png' }], ['spawn_agent', { message: 'x' }], ['mcp__postman__run', {}]] as [string, unknown][]) {
    assert.equal(run(call(name, input)).stdout, '{}', name);
    assert.equal(run(call(name, input), { CB_AGENT: 'codex' }).out.hookSpecificOutput?.permissionDecision, 'deny', `${name} in a seat launched without a role`);
  }
  assert.equal(run(bash('git reset --hard')).out.hookSpecificOutput?.permissionDecision, 'deny');
  // parity with Claude's shim, outside a seat: the same verdict for a question (with and without CB_ALLOW_ASK), a
  // dangerous command, a seat-only rule (writing the fence) and an ordinary command
  const claude = (tool_name: string, tool_input: unknown, env: Record<string, string> = {}) => !('decision' in run(JSON.stringify({ tool_name, tool_input }), env, join(GUARD, 'shim-claude.mjs')).out);
  const codex = (input: string, env: Record<string, string> = {}) => run(input, env).stdout === '{}';
  for (const env of [{}, { CB_ALLOW_ASK: '1' }]) {
    assert.equal(codex(call('request_user_input', { questions: [] }), env), claude('AskUserQuestion', { questions: [] }, env), `a question, ${JSON.stringify(env)}`);
    assert.equal(codex(call('request_user_input', { questions: [] }), env), 'CB_ALLOW_ASK' in env);
  }
  for (const command of ['git reset --hard', 'echo x > ~/.claude/settings.json', 'ls']) assert.equal(codex(bash(command)), claude('Bash', { command }), command);
  // unreadable input is never an unknown tool, seat or not
  for (const input of [call('', { command: 'ls' }), JSON.stringify({ tool_input: {} }), JSON.stringify({ tool_name: 5, tool_input: {} }), call('Bash', {}), 'nope']) {
    assert.equal(run(input).out.hookSpecificOutput?.permissionDecision, 'deny', input);
  }
});

test('a hook event other than PreToolUse blocks', () => {
  const r = run(call('Bash', { command: 'ls' }, { hook_event_name: 'PostToolUse' })).out.hookSpecificOutput;
  assert.match(r.permissionDecisionReason, /not PreToolUse/);
});

test('a shim copied without core.mjs still blocks (never fails open)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-codex-'));
  try {
    copyFileSync(SHIM, join(dir, 'shim-codex.mjs'));
    const r = run(bash('ls'), {}, join(dir, 'shim-codex.mjs')).out.hookSpecificOutput;
    assert.equal(r.permissionDecision, 'deny');
    assert.match(r.permissionDecisionReason, /^Blocked: guard failed to load core/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the parser: shell, edit and ask map to core tools; the in-process run matches the process', () => {
  assert.deepEqual(parseCodexInput(bash('ls')), { ok: true, tool: 'shell', command: 'ls' });
  for (const t of ['apply_patch', 'Edit', 'Write']) assert.deepEqual(parseCodexInput(call(t, {})), { ok: true, tool: 'edit', input: {}, cwd: null });
  assert.deepEqual(parseCodexInput(call('request_user_input', {})), { ok: true, tool: 'ask' });
  assert.deepEqual(runCodexShim(bash('ls'), {}), {});
  assert.deepEqual(runCodexShim(bash('git reset --hard'), {}), denial('Blocked dangerous command: git reset --hard'));
  assert.deepEqual(runCodexShim(undefined as any, {}), denial('Blocked: guard could not read hook input (empty stdin)'));
});

// #4618: the shapes Codex 0.160 really sends, read from its source at tag rust-v0.160.0 (codex-rs/core/src/tools):
// - exec_command, its only shell tool on every platform (PowerShell on Windows included), reaches the hook as
//   tool_name "Bash" with tool_input { command: <the raw command string> } (exec_command.rs pre_tool_use_payload,
//   HookToolName::bash()); there is no tool named unified_exec (that is the feature) and none named PowerShell
// - write_stdin sends no PreToolUse at all (write_stdin.rs: it continues a command that already ran PreToolUse as Bash)
// - apply_patch reaches it as tool_name "apply_patch" with tool_input { command: <the patch text> }
// - every other function tool reaches it under its own name with its JSON arguments (registry.rs default payload); the
//   catch-all matcher (#4609) sends them all here, and each is denied: pinned by name, so allowing one is a deliberate change
const real = (tool_name: string, tool_input: unknown) =>
  call(tool_name, tool_input, { cwd: 'C:/w/scratch', model: 'gpt-5', permission_mode: 'bypassPermissions', transcript_path: null });

test('Codex 0.160 exec_command, as the hook sees it (Bash + raw command): judged like a shell command, PowerShell forms too', () => {
  assert.equal(run(real('Bash', { command: 'git status' }), { CB_ROLE: 'builder' }).stdout, '{}');
  assert.equal(run(real('Bash', { command: 'Get-ChildItem -Force' }), { CB_ROLE: 'builder' }).stdout, '{}');
  for (const [command, env, why] of [
    ['git reset --hard', {}, /^Blocked dangerous command: /],
    ['Remove-Item -Recurse -Force C:\\', {}, /^Blocked dangerous command: /],
    ['git push origin main', { CB_ROLE: 'builder' }, /^Blocked by role \(builder\): /],
    ['git commit -m x', { CB_ROLE: 'reviewer' }, /^Blocked by role \(reviewer\): /],
    ['Get-Content .env', { CB_ROLE: 'builder' }, /^Blocked/],
    ['Set-Content -Path C:\\Users\\me\\.codex\\hooks.json -Value x', { CB_ROLE: 'builder' }, /^Blocked/],
  ] as const) {
    const out = run(real('Bash', { command }), env as Record<string, string>).out;
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, why, command);
  }
});

test('Codex 0.160 apply_patch, as the hook sees it ({ command: patch }): its file lines are the fence and secret targets', () => {
  const patch = (body: string) => real('apply_patch', { command: `*** Begin Patch\n${body}\n*** End Patch` });
  assert.equal(run(patch('*** Update File: src/a.ts\n@@\n-a\n+b'), { CB_ROLE: 'builder' }).stdout, '{}');
  for (const body of ['*** Add File: .env\n+X=1', '*** Update File: .codex/hooks.json\n@@\n-a\n+b', '*** Delete File: C:/Users/me/.claude-board/guard/core.mjs']) {
    assert.equal(run(patch(body), { CB_ROLE: 'builder' }).out.hookSpecificOutput?.permissionDecision, 'deny', body);
  }
});

// update_plan and view_image are judged since #4626 (see its tests below); the rest stay unknown
test('Codex 0.160\'s other tools reach the catch-all hook under their own names: each is denied, by name (#4618)', () => {
  const OTHERS: [string, unknown][] = [
    ['spawn_agent', { message: 'x' }],
    ['send_input', { id: 'a', message: 'x' }], ['wait_agent', { ids: ['a'] }], ['close_agent', { id: 'a' }], ['request_permissions', {}],
    ['list_mcp_resources', {}], ['read_mcp_resource', { server: 's', uri: 'u' }], ['tool_search', { query: 'x' }],
    ['exec_command', { cmd: 'git reset --hard' }], ['write_stdin', { session_id: 1, chars: 'git push origin main\n' }], ['unified_exec', { cmd: 'ls' }],
  ];
  for (const [name, input] of OTHERS) {
    const out = run(real(name, input), { CB_ROLE: 'builder' }).out;
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', name);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /^Blocked: unrecognized tool/, name);
  }
});

// #4626: Codex's write_stdin fires no hook (rust-v0.160.0 write_stdin.rs), so an allowed exec_command that opens an
// interactive session (a shell, REPL, database client or remote login) would run, unjudged, whatever write_stdin sends
// it next. Claude's Bash has no stdin, so a board seat gets the same: the session itself is refused. Codex passes the hook
// only { command } (not tty), so the rule is the same with or without a TTY.
const seat = (command: string, extra: Record<string, unknown> = {}) => run(call('Bash', { command }, extra), { CB_ROLE: 'builder', CB_AGENT: 'codex' }).out;
const SESSIONS = [
  'bash', 'bash -i', 'bash -s', 'sh -', 'zsh', 'bash --login', 'bash -l', 'fish', 'bash /dev/stdin', 'sudo -s', 'sudo -i', 'su', 'su - deploy', 'busybox sh',
  'pwsh', 'pwsh -NoExit -Command "Get-Date"', 'pwsh -Command -', 'powershell', 'powershell.exe -NoProfile', 'cmd', 'cmd.exe /k dir',
  'python', 'python3 -i x.py', 'python -', 'py', 'node', 'node -i', 'node -', 'irb', 'ghci', 'perl', 'ruby', 'php -a', 'lua', 'deno', 'deno repl', 'bun repl',
  'psql', 'psql -d app', 'mysql -u root', 'sqlite3 app.db', 'mongosh', 'redis-cli', 'sqlcmd -S .',
  'ssh host', 'ssh host bash', 'ssh -t host python3', 'telnet example.com 23', 'nc -l 9000', 'socat - TCP:x:1', 'tmux', 'screen', 'script', 'gdb ./a.out', 'expect',
  'docker exec -it web sh', 'docker run -it alpine', 'docker run -i alpine sh', 'podman attach c', 'docker compose exec web sh',
  'kubectl exec -it pod -- sh', 'kubectl exec --stdin pod -- sh', 'kubectl attach pod -i',
  'vim notes.md', 'less log.txt', 'man git', 'nano x', 'ed x',
  'grep foo | sh', 'grep -e x | sh', 'grep foo - | sh', 'tr a b | sh', 'head -n 5 | sh', 'sed s/a/b/ | bash', 'cut -f1 | sh',
  'cat | sh', 'cat | python', 'tee x | bash', 'head -c 9 | node', 'xargs git', "awk '{system($0)}'", 'read x; eval $x', 'select x in a b; do echo $x; done', 'echo $(python)', 'echo "$(bash)"',
  'Read-Host "cmd"', '$c = [Console]::ReadLine(); iex $c', 'foreach ($l in $input) { iex $l }', '$host.UI.ReadLine()',
  'env FOO=1 python', 'sudo bash', 'sudo -u web bash', 'nohup bash -i', 'FOO=1 node', 'timeout 60 python', 'cd /tmp && python', 'ls; bash', 'bash -c "python"', 'cat x.txt > /dev/tty',
  '/usr/bin/python3', 'C:\\Python311\\python.exe', '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"', 'if true; then bash; fi',
  'git status &&\\\nbash',
  // PR 104 review B1: a variable, a substitution or eval as the command word (a literal assignment earlier is read through)
  'X=bash; $X', 'X=bash; "$X"', 'X=vim; ${X} notes.txt', '$SHELL', '"$EDITOR" notes.md', 'eval bash', 'eval "python"', 'eval $cmd', '$(echo bash)', '`echo bash`',
  'exec $X',
  // B2: an explicit read of the seat's own input is no feed
  'bash <&0', 'exec 3<&0; bash <&3', 'bash < /dev/stdin', 'bash </dev/fd/0', 'python3 0<&0',
  // B3: a program that opens the terminal whatever feeds it, and git's and crontab's interactive modes
  'ls | vim -', 'git log | less', 'cat x | more', 'fzf', 'git ls-files | fzf', 'tig', 'htop', 'top', 'crontab -e', 'git add -p', 'git add --patch x',
  'git add -i', 'git checkout -p', 'git reset -p', 'git restore -p x', 'git stash -p', 'git commit --interactive', 'git rebase -i HEAD~3',
  'git rebase --interactive main', 'git clean -i', 'git -C wt add -p',
];
const ONE_SHOTS = [
  'bash -c "ls"', 'bash -lc "git status"', 'bash -ic "ls"', 'bash -c "python x.py" < /dev/null', 'sh script.sh', 'bash -e ./build.sh arg', 'zsh -c "echo hi"',
  'pwsh -Command "Get-ChildItem"', 'pwsh -File x.ps1', 'powershell -NoProfile -Command "Get-Date"', 'pwsh -NoProfile -c "1+1"', 'pwsh x.ps1', 'cmd /c dir', 'cmd.exe /C "echo hi"',
  'python x.py', 'python -c "print(1)"', 'python -m pytest -q', 'py -3 x.py', 'python3 -u -W ignore x.py', 'node x.js', 'node -e "1"', 'node --test', 'node -p 1+1',
  'ruby x.rb', 'perl -e 1', 'php x.php', 'php -r "echo 1;"', 'lua x.lua', 'deno run x.ts', 'bun run build',
  'psql -c "select 1"', 'psql -d app -f q.sql', 'mysql -e "select 1"', 'sqlite3 app.db "select 1"', 'redis-cli GET x', 'mongosh --eval "db.x"',
  'docker exec web ls', 'docker exec web sh', 'docker exec -it web ls', 'docker compose exec web npm test', 'kubectl exec -it pod -- ls', 'ssh host ls', 'ssh -n host bash', 'command -v python', 'timeout 60 python x.py', 'docker run --rm alpine echo hi', 'docker ps', 'docker compose up -d', 'kubectl exec pod -- ls', 'kubectl get pods',
  'cat notes.txt', 'cat a.txt | grep x', 'ls | xargs echo', 'xargs -a list.txt echo', 'sed -n 1p file.txt', "awk '{print $1}' file.txt", 'git log | head',
  'dd if=a of=b', 'tee < in.txt out.txt', 'echo hi | python', 'cat script.sh | bash', 'git log 2>&1 | head', 'nc -z host 80', 'python --version', 'vim --version',
  'while read l; do echo $l; done < f.txt', 'git log | while read l; do echo $l; done', "bash <<'EOF'\nls\nEOF", 'python <<EOF\nprint(1)\nEOF', 'python < script.py', 'bash <<< "ls"',
  'echo python', 'grep -rn bash .', 'git commit -m "run bash later"', 'git status', 'npm test', 'which python', 'Get-Content x.txt', 'Write-Host "Read-Host is a cmdlet"',
  // PR 104 review B4: grep, sed, head, tail and cut given a file read the file, not the seat's input
  'grep foo file | awk "{print}"', 'grep -rl x | xargs sed -i s/a/b/', 'head -n 5 file | sh', 'head -5 f | sh', 'sed -e s/a/b/ f | bash', 'sed s/a/b/ f | bash',
  'cut -d: -f1 /etc/passwd | xargs echo', 'grep -e x file | sh', 'tail -n 20 log | sh', 'grep -A3 -i foo a.txt b.txt | xargs echo', 'grep -r TODO | xargs echo',
  // B1: a variable read through to a one-shot, eval of a one-shot; B3: git's and crontab's other modes
  'X=python3; $X x.py', 'P=node; "$P" -e 1', 'eval "ls -la"', 'eval git status', 'crontab -l', 'top -b -n 1', 'git checkout -b feat/x', 'git add -A',
  'git rebase main', 'git stash push -m x', 'git log --oneline -5', 'git clean -fd', 'git commit -am x', 'vim --version | head -1',
];

test('a board seat may not open an interactive session (shell, REPL, client, remote, editor, stdin reader): write_stdin is never hooked (#4626)', () => {
  for (const c of SESSIONS) {
    const out = seat(c);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', c);
    // #4669 (merged after #4626): sudo, su, tmux and screen in a seat are refused first as a fresh-environment launch
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /write_stdin|fresh environment/, c);
  }
  // #4661 S1 runs first here (checkRole before the session rule): a git subcommand the shell fills in blocks on its own
  const read = seat('read -r cmd && git $cmd').hookSpecificOutput;
  assert.equal(read?.permissionDecision, 'deny');
  assert.match(read.permissionDecisionReason, /write_stdin|a subcommand the shell fills in/);
});

test('one-shot commands, input redirects and plain text naming a shell stay allowed (#4626)', () => {
  for (const c of ONE_SHOTS) assert.deepEqual(seat(c), {}, c);
  // #4669: sudo is no one-shot in a seat any more: another user's process runs without the seat's variables
  assert.match(seat('sudo -u web ls').hookSpecificOutput?.permissionDecisionReason ?? '', /fresh environment/);
});

test('the session rule ignores a tty field (the hook never sees one) and leaves a hand-started Codex alone (#4626)', () => {
  assert.equal(seat('python', { tty: true }).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(seat('python', { tty: false }).hookSpecificOutput?.permissionDecision, 'deny');
  // no CB_ROLE and no CB_AGENT: a person's own Codex (the hook is machine-wide), base rules only
  assert.equal(run(call('Bash', { command: 'python' })).stdout, '{}');
  assert.equal(run(call('Bash', { command: 'git reset --hard' })).out.hookSpecificOutput?.permissionDecision, 'deny');
});

test('the session rule stays linear: a long command of many segments is judged quickly (#4626)', () => {
  const long = Array.from({ length: 20000 }, (_, i) => `echo ${i} | grep x`).join('; ');
  const t0 = Date.now();
  assert.deepEqual(seat(long), {});
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});

// #4658 (PR 104 review I1-I3): a one-shot whose own code opens a session, a package runner or find that starts one, and
// the programs the tables missed
const CODE_SESSIONS = [
  // I1: interpreter code that hands the terminal to a shell or starts a REPL or debugger
  `python -c 'import pty; pty.spawn("/bin/sh")'`, `python3 -c "import code; code.interact()"`, `py -c "import code; code.InteractiveConsole().interact()"`,
  'python -m code', 'python -m pdb x.py', 'python3 -W ignore -m asyncio', `python -c "import pdb; pdb.set_trace()"`, `python -c "x=1; breakpoint()"`,
  `python -c "import os; os.system('bash')"`, `python -c "import subprocess; subprocess.call(['/bin/sh', '-i'])"`,
  `perl -e 'exec "/bin/sh"'`, `perl -e 'system("bash -i")'`, `ruby -e 'exec "sh"'`, `ruby -e 'binding.irb'`, `lua -e 'os.execute("sh")'`,
  `node -e "require('repl').start()"`, `node -e "require('node:repl').start({})"`, `node -p "require('repl').start()"`,
  `node -e "require('child_process').spawnSync('bash', { stdio: 'inherit' })"`, `node -e "require('child_process').execSync('sh')"`,
  `bash -c "python -m code"`,
  // the Windows shells too: Codex seats run on Windows
  `python -c "import os; os.system('cmd')"`, `python -c "import subprocess; subprocess.run(['powershell.exe'])"`,
  `node -e "require('child_process').spawnSync('pwsh', { stdio: 'inherit' })"`,
  // I2: package runners and find start the command that follows
  'npx bash', 'npx --yes node', 'npx -p x -- python', 'npx -c "bash"', 'pnpm exec bash', 'pnpm --filter web exec sh', 'pnpm dlx node',
  'npm exec -- node', 'npm x -- bash', 'yarn exec bash', 'yarn dlx node', 'bunx python', 'uv run python', 'poetry run bash', 'pipenv run python -i',
  'bundle exec irb', 'find . -exec bash \\;', 'find . -name x -execdir sh \\;', 'find . -exec python -i {} \\;',
  // I3: programs the tables missed
  'tclsh', 'wish', 'cat | tclsh','groovysh', 'jdb Main', 'evcxr', 'gore', 'nslookup',
];
const CODE_ONE_SHOTS = [
  `python -c "import os; os.system('cmd /c dir')"`, `node -e "require('child_process').execFileSync('cmd', ['/c', 'dir'])"`,
  `python -c "import subprocess; subprocess.run(['bash', '-c', 'ls'])"`, `python -c "import os; os.system('sh build.sh')"`,
  `python -c "print('code.interact is a function')"`, 'python -m pytest -q', 'python -m http.server --help', 'python -m pip list', 'python -c "import pty"',
  `perl -e 'system("ls -la")'`, `ruby -e 'system("ls")'`, `node -e "require('child_process').execSync('git status')"`,
  `node -e "require('child_process').spawnSync('bash', ['-c', 'ls'])"`, `node -e "console.log('repl')"`,
  'npx tsc --noEmit', 'npx --yes prettier --write x.ts', 'npx -c "tsc -b"', 'pnpm exec oxlint a.ts', 'pnpm --filter web exec tsc', 'pnpm dlx cowsay hi',
  'npm exec -- eslint .', 'npm exec node -- x.js', 'pnpm exec node x.js', 'pnpm install', 'pnpm -s build', 'npm test', 'yarn build', 'bunx vite build',
  'uv run pytest', 'uv run python x.py', 'poetry run pytest -q', 'bundle exec rake', 'pnpm exec bash -c "ls"',
  'find . -name "*.ts"', 'find . -exec grep -l x {} +', 'find . -name "*.sh" -exec bash {} \\;', 'find . -exec rm {} \\;', 'find . -type f -exec sh -c "wc -l x" \\;',
  'tclsh x.tcl', 'wish x.tcl', 'nslookup example.com', 'cat q.tcl | tclsh',
];

test('a board seat may not open a session through one-shot code, a package runner, find or a missed program (#4658)', () => {
  for (const c of CODE_SESSIONS) {
    const out = seat(c);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', c);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /write_stdin|fresh environment/, c);
  }
});

test('everyday one-shots through interpreters, package runners and find stay allowed (#4658)', () => {
  for (const c of CODE_ONE_SHOTS) assert.deepEqual(seat(c), {}, c);
});

test('the one-shot code and runner reading stays linear (#4658)', () => {
  for (const long of ['python -c "' + 'os.system( '.repeat(8000) + '"', 'node -e "' + 'spawn('.padEnd(100000, ' ') + '"',
    'npx ' + '--yes '.repeat(20000) + 'tsc', 'find . ' + '-exec echo x \\; '.repeat(4000)]) {
    const t0 = Date.now();
    seat(long);
    assert.ok(Date.now() - t0 < 3000, `${long.slice(0, 40)}: ${Date.now() - t0} ms`);
  }
});

test('update_plan is allowed; view_image is a read with the secret rule; spawn_agent stays denied (#4626)', () => {
  const b = { CB_ROLE: 'builder', CB_AGENT: 'codex' };
  assert.equal(run(call('update_plan', { plan: [{ step: 'x', status: 'pending' }] }), b).stdout, '{}');
  assert.equal(run(call('view_image', { path: 'docs/a.png' }, { cwd: '/w' }), b).stdout, '{}');
  for (const input of [{ path: '.env' }, { path: '/home/me/.ssh/id_ed25519' }, {}, { path: 7 }]) {
    assert.equal(run(call('view_image', input, { cwd: '/w' }), b).out.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(input));
  }
  assert.equal(run(call('spawn_agent', { message: 'x' }), b).out.hookSpecificOutput?.permissionDecision, 'deny');
});
