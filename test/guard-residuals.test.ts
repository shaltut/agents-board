import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { evaluate, ROLES, scriptReader } from '../kit/guard/core.mjs';
import { runClaudeShim } from '../kit/guard/shim-claude.mjs';
import { runCodexShim } from '../kit/guard/shim-codex.mjs';
import { runAgyShim } from '../kit/guard/shim-agy.mjs';
import { runOpencodeShim } from '../kit/guard/shim-opencode.mjs';

const ev = (command: string, role = 'builder', extra = {}) => evaluate({ tool: 'shell', command, role, ...extra });

test('#4707: loopback spellings, local DNS suffixes and interface addresses are local SSH destinations', () => {
  const hosts = ['seat.example.test', '192.0.2.7', '100.64.0.7'];
  for (const host of ['127.1', '127.0.1', '0x7f000001', '2130706433', '0177.0.0.1', 'localhost.', 'seat.', 'seat.local',
    'seat.example.test.', 'seat.tailnet.ts.net', '192.0.2.7', '100.64.0.7']) {
    for (const role of ROLES) assert.equal(ev(`ssh user@${host} codex`, role, { hosts }).kind, 'role', `${role}: ${host}`);
  }
  for (const command of ['ssh -T git@github.com', 'ssh remote.example uptime', 'echo ssh localhost', 'rg sudo src']) {
    assert.deepEqual(ev(command, 'builder', { hosts }), { allow: true }, command);
  }
});

test('#4707 R2-1: a lead variable SSH destination cannot conceal a local host', () => {
  for (const command of ['VPS=localhost; ssh "$VPS" codex', 'VPS=127.1; ssh "${VPS}" codex',
    'DEPLOY_HOST=localhost; ssh $DEPLOY_HOST codex', 'TARGET=localhost; ssh "$TARGET" codex',
    'VPS=localhost; ssh "$VPS" codex; VPS=remote.example']) {
    assert.equal(ev(command, 'lead').kind, 'role', command);
  }
  assert.deepEqual(ev('VPS=vps2; ssh "$VPS" uptime', 'lead'), { allow: true });
  for (const command of ['VPS=remote.example; ssh "$VPS" uptime', 'ssh "$OTHER_HOST" codex', 'ssh "$VPS" codex']) {
    assert.equal(ev(command, 'lead').allow, false, command);
  }
  const out = runClaudeShim(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ssh "$VPS" codex' } }),
    { CB_ROLE: 'lead', VPS: 'localhost' });
  assert.equal(out.decision, 'block', 'an inherited deploy variable can also be local');
  assert.deepEqual(ev('ssh "$VPS" uptime', 'lead', { deployHost: 'vps2' }), { allow: true });
  assert.equal(ev('ssh "$VPS" uptime', 'lead', { deployHost: 'remote.example' }).allow, false);
  assert.equal(ev('ssh "$VPS" uptime', 'lead', { deployHost: 'vps2', hosts: ['vps2'] }).allow, false);
});

test('#4707 R2-2/R2-3: assignment names are unquoted as whole words; quoted values stay values', () => {
  for (const command of ['export "$x"=', "export $x''=", String.raw`export $x\=`, 'declare "$x"=',
    'x=CB_ROLE; export "$x"=; codex', 'readonly "${x}"=']) {
    assert.equal(ev(command).kind, 'role', command);
  }
  for (const command of ['local args="--set $k=$v"', 'export args="--set $k=$v"', 'local a="hello world $k=$v"',
    'local x; echo "$k=$v"', 'export A=1; echo "url=$BASE=ok"']) assert.deepEqual(ev(command), { allow: true }, command);
});

test('#4707: escaped launchers, wrapper arguments and command substitutions retain command position', () => {
  for (const command of [String.raw`s\udo codex`, String.raw`su\do codex`, 'xargs sudo', 'xargs -a f sudo', 'busybox su',
    String.raw`C:\tools\sudo.exe codex`,
    'echo $(sudo codex)', 'x=$(herdr pane send-text w1 codex)', 'echo "$(sudo codex)"',
    'herdr pane send-text w1 codex', 'node -e "const env={}; spawn(c,[],{env})"']) {
    assert.equal(ev(command).kind, 'role', command);
  }
  for (const command of ['echo sudo', 'rg "sudo codex" src', 'xargs -a f echo hello', 'busybox echo su',
    'echo "$(date)"', 'node -e "spawn(c,[],{env: process.env})"', 'node -e "spawn(c,[],{env: {...process.env, X: 1}})"']) {
    assert.deepEqual(ev(command), { allow: true }, command);
  }
});

test('#4707: shell input, nested scripts, changed cwd and oversized scripts are inspected by every shim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-residuals-'));
  try {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'bad.sh'), 'sudo codex\n');
    writeFileSync(join(dir, 'inner.sh'), 'bash bad.sh\n');
    writeFileSync(join(dir, 'cd-inner.sh'), 'cd sub\nbash bad.sh\n');
    writeFileSync(join(dir, 'deploy.sh'), 'VPS=${VPS:-vps2}\nssh "$VPS" uptime\n');
    writeFileSync(join(dir, 'sub', 'bad.sh'), 'unset CB_ROLE\n');
    writeFileSync(join(dir, 'big.sh'), '# padding\n'.repeat(35000) + 'sudo codex\n');
    writeFileSync(join(dir, 'ok.sh'), 'echo hi\n');
    writeFileSync(join(dir, 'cycle.sh'), 'bash cycle.sh\n');
    const seat = (agent: string) => ({ CB_ROLE: 'builder', CB_AGENT: agent });
    const runners = [
      (command: string) => runClaudeShim(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir }), seat('claude')),
      (command: string) => runCodexShim(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dir }), seat('codex')),
      (command: string) => runAgyShim(JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: dir } }, cwd: tmpdir() }), seat('agy')),
      (command: string) => runOpencodeShim(JSON.stringify({ tool: 'bash', args: { command: `cd "${dir}" && ${command}` } }), seat('opencode')),
    ];
    for (const run of runners) {
      for (const command of ['cat bad.sh | bash', 'bash < bad.sh', 'bash inner.sh', 'bash cd-inner.sh', 'cd sub && bash bad.sh', 'bash big.sh']) {
        assert.match(JSON.stringify(run(command)), /Blocked/, command);
      }
      for (const command of ['bash ok.sh', 'cat ok.sh | bash', 'bash < ok.sh', 'cat bad.sh', 'echo ok']) {
        assert.doesNotMatch(JSON.stringify(run(command)), /Blocked/, command);
      }
      // Termination is mandatory even for a cycle; a bounded traversal may conservatively deny it.
      run('bash cycle.sh');
    }
    const readScript = scriptReader(dir, { readFileSync, statSync, resolve });
    assert.equal(ev('bash big.sh', 'builder', { readScript }).allow, false);
    assert.equal(ev('VPS=localhost bash deploy.sh', 'lead', { readScript }).allow, false);
    assert.deepEqual(ev('VPS=vps2 bash deploy.sh', 'lead', { readScript }), { allow: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#4707: real shims receive this machine names and interface addresses', () => {
  const hosts = [hostname() + '.local', hostname() + '.tailnet.ts.net',
    ...Object.values(networkInterfaces()).flatMap((items) => (items ?? []).map((item) => item.address))];
  for (const host of hosts) {
    const out = runClaudeShim(JSON.stringify({ tool_name: 'Bash', tool_input: { command: `ssh ${host} codex` } }), { CB_ROLE: 'builder' });
    assert.equal(out.decision, 'block', host);
  }
});
