// Claude Code PreToolUse hook (matcher: Bash). Blocks dangerous shell commands.
// Unlike a grep over the whole command, it ignores message text (cb tell, git commit -m, gh --body,
// heredoc bodies written to files), so "the shutdown is planned" can be posted.
// Shell patterns match only where a command starts; SQL and a few flag patterns match anywhere.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A message-writing command plus its same-line args (quoted or bare words; stops at ; & | or newline).
const QUOTED = `"(?:\\\\.|[^"\\\\])*"|'[^']*'`;
const MESSAGE_CMD = new RegExp(
  `(\\bcb[ \\t]+(?:tell|ask|log|add|done|move|fail|pass|edit)\\b|\\bgit[ \\t]+commit\\b|\\bgh[ \\t]+pr[ \\t]+(?:create|comment|review)\\b)` +
    `((?:[ \\t]+(?:${QUOTED}|[^\\s;&|"'])+)*)`,
  'g',
);
const HEREDOC = /^([^\n]*<<-?[ \t]*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/gm;
const WRITES_TEXT = /(?:^|[;&|][ \t]*)(?:cb[ \t]|cat[ \t]*>>?[ \t]*\S|git[ \t]+commit\b.*-F[ \t]+-)/;

export function stripMessages(cmd) {
  return cmd
    .replace(HEREDOC, (all, line, _q, id) => (WRITES_TEXT.test(line) ? `${line}\n${id}` : all))
    .replace(MESSAGE_CMD, (_all, head, args) => head + args.replace(new RegExp(QUOTED, 'g'), '""'));
}

// Where a command may begin: start, newline, ; & | ( ` or just inside an opening quote; optional sudo.
const START = '(?:^|[\\n;&|`(]|["\'])[ \\t]*(?:sudo[ \\t]+(?:-\\S+[ \\t]+)*)?';
const atStart = (name, body) => [name, new RegExp(START + body, 'i')];
const anywhere = (name, re) => [name, new RegExp(re, 'i')];

const PATTERNS = [
  atStart('rm -rf /', 'rm[ \\t]+-(?:rf|fr)[ \\t]+(?:/\\*?(?=[\\s"\';&|)]|$)|~)'),
  atStart('mkfs.', 'mkfs\\.'),
  atStart('dd of=/dev/', 'dd[ \\t]+if=.*\\bof=/dev/'),
  atStart('fork bomb', ':\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:'),
  atStart('chmod -R 777 /', 'chmod[ \\t]+-R[ \\t]+777[ \\t]+/'),
  atStart('mv to /dev/null', 'mv[ \\t].*[ \\t]/dev/null'),
  atStart('pipe to shell', '(?:wget|curl)[ \\t].*\\|[ \\t]*(?:sudo[ \\t]+)?(?:ba)?sh\\b'),
  atStart('shutdown', 'shutdown\\b'),
  atStart('reboot', 'reboot\\b'),
  atStart('init 0/6', 'init[ \\t]+[06]\\b'),
  atStart('format c:', 'format[ \\t]+c:'),
  atStart('del c:', 'del[ \\t]+/f[ \\t]+/s[ \\t]+/q[ \\t]+c:'),
  atStart('git push --force main', 'git[ \\t]+push\\b(?=.*--force)(?=.*\\b(?:main|master)\\b)'),
  atStart('git reset --hard', 'git[ \\t]+reset[ \\t]+--hard'),
  anywhere('> /dev/sda', '>[ \\t]*/dev/sd[a-z]'),
  anywhere('--no-preserve-root', '--no-preserve-root'),
  anywhere('drop database', '\\bdrop[ \\t\\n]+database\\b'),
  anywhere('drop table', '\\bdrop[ \\t\\n]+table\\b'),
];

// Returns the name of the matched pattern, or null when the command is fine.
export function check(command) {
  const text = stripMessages(String(command ?? ''));
  return PATTERNS.find(([, re]) => re.test(text))?.[0] ?? null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let reason = null;
  try {
    reason = check(JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command);
  } catch {} // bad or empty stdin: allow, never block everything
  process.stdout.write(JSON.stringify(reason ? { decision: 'block', reason: `Blocked dangerous command: ${reason}` } : {}));
}
