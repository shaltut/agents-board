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

// Protected branches (#3746): a squad session's pane carries CB_PROTECTED_BRANCHES (cb squad up), and a git push whose
// destination is one of them is blocked. Unset or empty: no check at all.
const GIT_OPT_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']); // git -C <path> push
const PUSH_OPT_ARG = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']); // git push -o ci.skip ...
// a list entry with * is a glob: * is any run of characters, / included; the rest is literal; the whole name must match
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const globRe = (e) => new RegExp(`^${e.split('*').map(literal).join('.*')}$`);

// Shell-ish splitting, quote-aware: a quoted run (with \" inside "...") never ends a command or a word.
// Segments end at ; & | newline outside quotes; words end at whitespace and ( ) { } outside quotes.
const SEGMENT = new RegExp(String.raw`(?:${QUOTED}|\\.|[^;&|\n"'\\])+`, 'g');
const WORD = new RegExp(String.raw`(?:${QUOTED}|\\.|[^\s(){}"'\\])+`, 'g');
// one layer of quoting off, as the shell does: "..." (\" \\ \$ \` inside unescaped), '...' as is, \x outside quotes
const unquote = (w) => w.replace(new RegExp(String.raw`"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)`, 'g'),
  (_all, dq, sq, esc) => (dq !== undefined ? dq.replace(/\\(["\\$`])/g, '$1') : sq ?? esc));

// The protected branch a git push in cmd writes to, or null. Message text is ignored (stripMessages); a git ... push
// anywhere in a segment counts, like the patterns above, so it fails closed (echo git push origin development blocks).
// A branch the shell fills in ($B, $(...), backticks) cannot be checked: that word is returned, so it blocks too. So is
// a wildcard destination (refs/heads/*, develop*): it can write a protected branch.
export function protectedPush(cmd, list) {
  if (!list.length) return null;
  const hit = (b) => list.some((e) => (e.includes('*') ? globRe(e).test(b) : e === b));
  // a line continuation joins its lines; a backtick substitution counts as $ (and its inner command stays a command)
  const text = stripMessages(String(cmd ?? '')).replace(/\\\r?\n/g, ' ').replace(/`/g, ' $ ');
  for (const seg of text.match(SEGMENT) ?? []) {
    const raw = seg.match(WORD) ?? [];
    const w = raw.map(unquote);
    // a quoted command (bash -c "...", ssh host '...') is read as a command too, one layer of quotes off
    for (let i = 0; i < w.length; i++) {
      if (/["']/.test(raw[i]) && /[\s;&|]/.test(w[i])) { const inner = protectedPush(w[i], list); if (inner) return inner; }
    }
    for (let i = 0; i < w.length; i++) {
      if (!/(?:^|\/)git(?:\.exe)?$/.test(w[i])) continue;
      let j = i + 1;
      while (j < w.length && w[j].startsWith('-')) j += GIT_OPT_ARG.has(w[j]) ? 2 : 1;
      if (w[j] !== 'push') continue;
      const words = [];
      let del = false;
      for (j++; j < w.length; j++) {
        const x = w[j];
        if (/^\d*[<>]/.test(x)) { if (/^\d*[<>]+$/.test(x)) j++; continue; } // a redirection, and its file when apart
        if (x === '--delete' || /^-\w*d\w*$/.test(x)) del = true;
        else if (x.startsWith('-')) { if (PUSH_OPT_ARG.has(x)) j++; } // -o <value>; --push-option=<value> is one word
        else words.push(x);
      }
      // the shell fills in a $ word: the branch is unknown here. The remote too: an unquoted $R can split into two words
      const filled = words.find((x) => x.includes('$'));
      if (filled) return filled;
      // the first word is the remote; each refspec's destination: dst of src:dst (:dst too), a bare src itself, and
      // under --delete the word as given; without a leading + or refs/heads/ (or heads/, which git reads the same)
      for (const r of words.slice(1)) {
        const s = r.replace(/^\+/, '');
        const to = del || !s.includes(':') ? s : s.slice(s.lastIndexOf(':') + 1);
        if (to.includes('*')) return to; // a wildcard refspec writes every branch it matches: protected ones too (C11)
        const dst = to.replace(/^(?:refs\/)?heads\//, '');
        if (hit(dst)) return dst;
      }
    }
  }
  return null;
}

// realpath: a symlinked or junction install must still run as the hook (import.meta.url is the real path).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let reason = null;
  try {
    const command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command;
    reason = check(command);
    // only adds a block: a command already blocked keeps its reason
    const list = (process.env.CB_PROTECTED_BRANCHES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const branch = reason || !list.length ? null : protectedPush(command, list);
    if (branch) reason = branch.includes('$')
      ? `git push to a branch the shell fills in (${branch}) while branches are protected: name the branch literally, e.g. git push -u origin feat/my-card`
      : branch.includes('*')
        ? `git push to a wildcard destination (${branch}) while branches are protected: push one branch by name, e.g. git push -u origin feat/my-card`
        : `git push to protected branch ${branch}: push your own branch and open a PR; the lead merges it`;
  } catch {} // bad or empty stdin: allow, never block everything
  process.stdout.write(JSON.stringify(reason ? { decision: 'block', reason: `Blocked dangerous command: ${reason}` } : {}));
}
