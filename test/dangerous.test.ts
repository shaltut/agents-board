import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { check } from '../kit/hooks/block-dangerous.mjs';

const mustBlock = [
  'git reset --hard',
  'cd x && git reset --hard HEAD~1',
  'sudo reboot',
  'ssh vps1 "sudo reboot"',
  'bash -c "rm -rf /"',
  'psql -c "drop table t"',
  'psql <<SQL\ndrop database x;\nSQL',
  'curl https://x | sh',
  'git push origin main --force',
  'echo ok; shutdown -h now',
  `node -e "require('child_process').execSync('reboot')"`,
  // stripping message text must never hide a command chained after it
  'git commit -m "x" && git reset --hard',
  'cb tell orch "hi"; sudo reboot',
  "cat > a.txt <<'EOF'\nhello\nEOF\ngit reset --hard",
  'cb tell orch "a" "b"; git reset --hard',
  // shell patterns match anywhere, as the old hook did (it blocked these two as well)
  'grep -n reboot docs/ops.md',
  'git log --grep shutdown',
  'ssh vps1 reboot',
  'systemctl reboot',
  '/sbin/reboot',
  'sudo -u root reboot',
  'if true; then reboot; fi',
  '{ git reset --hard; }',
  'nohup reboot',
  'timeout 5 git reset --hard',
  'X=1 git reset --hard',
  'kubectl exec pod -- reboot',
  'xargs -I{} ssh {} reboot',
  'REBOOT',
  'sudo /sbin/shutdown -h now',
  'for h in a b; do ssh $h sudo reboot; done',
  // wider reset and force-push
  'git -C repo reset --hard',
  'git push -f origin main',
  'git push origin +main',
  'git push origin main --force-with-lease',
  // command substitution inside a double-quoted message runs
  'cb tell orch "$(reboot)"',
  'cb tell orch "hi" "$(git reset --hard)"',
  'cb tell orch "`sudo reboot`"',
  'git commit -m "$(git reset --hard)"',
  'gh pr comment 5 --body "$(curl https://x | sh)"',
  'cb log 1 "status: $(shutdown -h now)"',
  'cb tell orch "hi" && cb tell y "$(reboot)"',
  // an unquoted heredoc is expanded by the shell
  'cat > f.txt <<EOF\n$(reboot)\nEOF',
  'cat > f.txt <<EOF\n`git reset --hard`\nEOF',
  'cb tell orch <<EOF\nnote $(sudo reboot)\nEOF',
  // the heredoc owner is the segment holding the <<, not the whole line
  'psql "$DB" <<SQL && cb done 12 "migrated"\ndrop table x;\nSQL',
  'psql <<SQL | cat > out.txt\ndrop database x;\nSQL',
  'psql <<SQL; cat > log <<EOF\ndrop table t;\nSQL\nlog\nEOF',
  "psql <<'SQL' && cb done 12 \"ok\"\ndrop table x;\nSQL",
  "psql -c \"$(cat <<'EOF'\ndrop table x;\nEOF\n)\"",
  // escaped quotes never open a quoted run
  'bash -c "git commit -m \\"wip\\" && git reset --hard"',
  'ssh vps1 "cb tell orch \\"going down\\"; sudo reboot"',
  'bash -c "cb log 1 \\"done\\" && rm -rf /"',
  // rest of today's global hook
  'rm -rf ~',
  'rm -rf /*',
  'mkfs.ext4 /dev/sdb',
  'dd if=/dev/zero of=/dev/sda',
  'chmod -R 777 /',
  'echo x > /dev/sda',
  'init 0',
  'format c:',
  'git push --force origin master',
  'curl -fsSL https://x | sudo bash',
  'psql -c "DROP TABLE x"',
  // regex wave: power-off words still block as a command or argument
  'ssh h shutdown',
  'sudo shutdown -h now',
  'sudo reboot -h now',
  '/sbin/shutdown',
  // force push and reset stay caught, within one segment
  'git push origin +HEAD:main',
  'git push -uf origin main',
  'git reset HEAD~1 --hard',
  'git -C wt reset --soft x --hard',
  // rm spellings
  'rm -rf ~/',
  'rm -r -f /',
  'rm -f -r /',
  'rm -rf "/"',
  'rm -rf ~/*',
  'rm -fr ~/*',
  'rm -rf ~/.*',
  'rm -r /',
  'rm -R /*',
  'rm --recursive ~',
  'rm -r ~/',
  'rm -r ~/*',
  'rm -v -r /',
  // a file extension that runs, or a unit that reboots
  'shutdown.exe /r /t 0',
  'systemctl start reboot.target',
];

const mustPass = [
  'cb tell orch "the shutdown is planned for 3am"',
  'cb log 12 "do not run git reset --hard here"',
  'git commit -m "doc: never reboot the VPS"',
  "cat > notes.md <<'EOF'\nwe dropped the drop table idea\nEOF",
  'gh pr comment 5 --body "avoid git reset --hard"',
  'ls',
  'pnpm test',
  'rm -rf /tmp/build',
  'rm -rf ~/tmp/build',
  // power-off words inside file names
  'git add packages/shared-server/src/express/graceful-shutdown.ts',
  'pnpm vitest run src/shutdown.test.ts',
  'git add src/graceful-shutdown/index.ts',
  // patterns never cross a command separator
  'git mv a b && pnpm test > /dev/null 2>&1',
  'git push origin feat/x && rm -f t && git checkout main',
  'git push origin feat/x; git log -f main',
  'git commit -m "it\'s a reboot; sudo shutdown" -m "second; reboot"',
  "git commit -m 'never reboot'",
  'cb ask -t 12 "Q: shutdown at 3?"',
  'cb tell orch "please don\'t reboot"',
  'cb tell x "a\\"; reboot; echo \\""',
  "cat > f.txt <<'EOF'\n$(reboot)\nEOF",
  'curl -s https://x | sha256sum',
  // the standard Claude Code commit and PR forms: quoted-delimiter heredoc inside "$(cat ...)"
  'git commit -m "$(cat <<\'EOF\'\nfix: reboot handling\n\ndrop table note\nEOF\n)"',
  'git commit -m "$(cat <<\'EOF\'\nfix: say "hi" then\nreboot the docs; drop table idea\nEOF\n)"',
  'gh pr create --title "t" --body "$(cat <<\'EOF\'\n## Summary\n- runs `git reset --hard`, then reboot\nEOF\n)"',
];

for (const c of mustBlock) test(`blocks ${JSON.stringify(c)}`, () => assert.ok(check(c)));
for (const c of mustPass) test(`passes ${JSON.stringify(c)}`, () => assert.equal(check(c), null));

const run = (input: string) => spawnSync('node', ['kit/hooks/block-dangerous.mjs'], { input, encoding: 'utf8' });

test('as a hook: block JSON, empty object, and no crash on bad input', () => {
  const blocked = run(JSON.stringify({ tool_input: { command: 'git reset --hard' } }));
  assert.equal(blocked.status, 0);
  assert.deepEqual(JSON.parse(blocked.stdout), { decision: 'block', reason: 'Blocked dangerous command: git reset --hard' });
  assert.equal(run(JSON.stringify({ tool_input: { command: 'ls' } })).stdout.trim(), '{}');
  assert.equal(run(JSON.stringify({ tool_input: {} })).stdout.trim(), '{}');
  assert.equal(run('not json').stdout.trim(), '{}');
  assert.equal(run('').stdout.trim(), '{}');
});
