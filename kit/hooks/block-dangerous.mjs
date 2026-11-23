// Claude Code PreToolUse hook (matcher: Bash). Blocks dangerous shell commands.
// Unlike a grep over the whole command, it ignores message text (cb tell, git commit -m, gh --body,
// quoted-delimiter heredoc bodies written to files), so "the shutdown is planned" can be posted.
// What is left is matched ANYWHERE, like the old hook: a fence fails closed (ssh host reboot, nohup, xargs ...).
// Text the shell would expand ("$(...)", backticks, unquoted heredocs) is never stripped.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const QUOTED = String.raw`"(?:\\.|[^"\\])*"|'[^']*'`;
// A message command plus its same-line args: quoted runs, escaped pairs or bare words (stops at ; & | newline).
const MESSAGE_HEAD = String.raw`\bcb[ \t]+(?:tell|ask|log|add|done|move|fail|pass|edit)\b|\bgit[ \t]+commit\b|\bgh[ \t]+pr[ \t]+(?:create|comment|review)\b`;
const MESSAGE_CMD = new RegExp(String.raw`(${MESSAGE_HEAD})((?:[ \t]+(?:${QUOTED}|\\.|[^\s;&|"'\\])+)*)`, 'g');
// Only a quoted-delimiter heredoc is literal; an unquoted <<EOF body is expanded by the shell.
const HEREDOC = /^([^\n]*<<-?[ \t]*(['"])(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/gm;
const TEXT_WRITER = /^[ \t]*(?:cb[ \t]|cat[ \t]*>>?[ \t]*\S|git[ \t]+commit\b.*-F[ \t]+-)/;
const SUBST_CAT = /\$\([ \t]*cat[ \t]*$/;
const MESSAGE_ARG = new RegExp(String.raw`(?:^|[;&|(][ \t]*)(?:${MESSAGE_HEAD})[^;&|\n]*"$`);

// Does the heredoc header line belong to a text writer? Judged from the command segment holding the <<.
function writesText(line) {
  if (line.split('<<').length !== 2) return false; // two heredocs on one line: strip neither
  const at = line.indexOf('<<');
  const before = line.slice(0, at);
  if (SUBST_CAT.test(before)) return MESSAGE_ARG.test(before.replace(SUBST_CAT, '')); // "$(cat <<'EOF' in a message arg
  const seg = before.slice(Math.max(...[';', '&', '|', '('].map((c) => before.lastIndexOf(c))) + 1);
  const after = line.slice(at).search(/[;&|]/);
  return TEXT_WRITER.test(seg + (after < 0 ? line.slice(at) : line.slice(at, at + after)));
}

export function stripMessages(cmd) {
  return cmd
    .replace(HEREDOC, (all, line, _q, id) => (writesText(line) ? `${line}\n${id}` : all))
    .replace(MESSAGE_CMD, (_all, head, args) =>
      head + args.replace(new RegExp(QUOTED, 'g'), (q) => (/^"/.test(q) && /\$\(|`/.test(q) ? q : '""')));
}

const PATTERNS = [
  // recursive rm (any flag order, -r/-R/--recursive, with or without -f; a non-TTY rm -r never prompts);
  // the target is a bare / /* ~ ~/ ~/* ~/.* (also quoted), not ~/tmp/x
  ['rm -rf /', String.raw`\brm[ \t]+(?:--?[a-z-]+[ \t]+)*(?:-[a-z]*r[a-z]*|--recursive)(?:[ \t]+--?[a-z-]+)*[ \t]+["']?(?:/\*?|~(?:/\.?\*)?/?)(?=["'\s;&|)]|$)`],
  ['mkfs.', String.raw`\bmkfs\.`],
  ['dd of=/dev/', String.raw`\bdd[ \t]+if=.*\bof=/dev/`],
  ['fork bomb', String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`],
  ['chmod -R 777 /', String.raw`\bchmod[ \t]+-R[ \t]+777[ \t]+/`],
  ['mv to /dev/null', String.raw`\bmv[ \t][^;&|\n]*[ \t]/dev/null`], // one command segment: "git mv a b && x > /dev/null" is fine
  ['pipe to shell', String.raw`\b(?:wget|curl)[ \t].*\|[ \t]*(?:sudo[ \t]+)?(?:ba)?sh\b`],
  // a power-off word as a command or argument, not inside a file name (graceful-shutdown.ts, shutdown.test.ts)
  // (a trailing dot is a file name unless it is .exe or .target: shutdown.exe, reboot.target)
  ['shutdown', String.raw`(?<![\w.-])shutdown(?![\w/-])(?!\.(?!(?:exe|target)\b))`],
  ['reboot', String.raw`(?<![\w.-])reboot(?![\w/-])(?!\.(?!(?:exe|target)\b))`],
  ['init 0/6', String.raw`\binit[ \t]+[06]\b`],
  ['format c:', String.raw`\bformat[ \t]+c:`],
  ['del c:', String.raw`\bdel[ \t]+/f[ \t]+/s[ \t]+/q[ \t]+c:`],
  ['git push --force main', String.raw`\bgit\b[^;&|\n]*\bpush\b(?=[^;&|\n]*(?:--force|[ \t]-[a-z]*f[a-z]*\b|\+\S*\b(?:main|master)\b))(?=[^;&|\n]*\b(?:main|master)\b)`], // one segment only
  ['git reset --hard', String.raw`\breset\b[^;&|\n]*--hard\b`],
  ['> /dev/sda', String.raw`>[ \t]*/dev/sd[a-z]`],
  ['--no-preserve-root', String.raw`--no-preserve-root`],
  ['drop database', String.raw`\bdrop[ \t\n]+database\b`],
  ['drop table', String.raw`\bdrop[ \t\n]+table\b`],
].map(([name, re]) => [name, new RegExp(re, 'i')]);

// Returns the name of the matched pattern, or null when the command is fine.
export function check(command) {
  const text = stripMessages(String(command ?? ''));
  return PATTERNS.find(([, re]) => re.test(text))?.[0] ?? null;
}

// realpath: a symlinked or junction install must still run as the hook (import.meta.url is the real path).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let reason = null;
  try {
    reason = check(JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command);
  } catch {} // bad or empty stdin: allow, never block everything
  process.stdout.write(JSON.stringify(reason ? { decision: 'block', reason: `Blocked dangerous command: ${reason}` } : {}));
}
