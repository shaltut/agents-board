// Claude Code PreToolUse hook (matcher: Bash; on Windows Bash|PowerShell). Blocks dangerous shell commands.
// Unlike a grep over the whole command, it ignores message text (cb tell, git commit -m, gh --body,
// quoted-delimiter heredoc bodies written to files), so "the shutdown is planned" can be posted.
// What is left is matched ANYWHERE, like the old hook: a fence fails closed (ssh host reboot, nohup, xargs ...).
// Text the shell would expand ("$(...)", backticks, unquoted heredocs) is never stripped.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const QUOTED = String.raw`"(?:\\.|[^"\\])*"|'[^']*'`;
// A message command plus its same-line args: quoted runs, escaped pairs or bare words (stops at ; & | newline).
const MESSAGE_HEAD = String.raw`\bcb[ \t]+(?:tell|ask|log|add|done|move|fail|pass|edit)\b|\bgit[ \t]+commit\b|\bgh[ \t]+pr[ \t]+(?:create|comment|review)\b|\bherdr(?:[ \t]+--machine[ \t]+\S+)?[ \t]+agent[ \t]+prompt\b`;
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
      // kept: a "$(...)" or backtick the shell runs, and a herdr prompt starting with ! (it runs as a shell command there)
      head + args.replace(new RegExp(QUOTED, 'g'), (q) =>
        ((/^herdr/.test(head) && /^["']!/.test(q)) || (/^"/.test(q) && /\$\(|`/.test(q)) ? q : '""')));
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
  return PATTERNS.find(([, re]) => re.test(text))?.[0] ?? (killByName(text) ? KILL_BY_NAME : null);
}

// Kill by process name (#3809): a name stops every process that has it, other sessions' too. On 24 Nov one session's
// Get-Process node | Stop-Process killed the PC's job runner, its supervisor and every session's relay, twice.
// (pwsh 7.6 preview on the PC cannot load CIM, so its list and port commands run in Windows PowerShell or netstat)
const KILL_BY_NAME = `kill by process name: it stops every process with that name on this machine, other sessions' too (node: the board runner, supervisor and relays). A lookup by name (Get-Process node, pgrep, ps | grep, Win32_Process) feeding a stop counts too. Stop only yours, by PID: note it when you start the process (Start-Process -PassThru, or $! in bash), or list them with their command lines and pick yours (Windows PowerShell: Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Format-List ProcessId, CommandLine; from pwsh wrap it in powershell -NoProfile { ... }; Mac: pgrep -fl node), then stop it in the next command: Stop-Process -Id <pid> (Git Bash: taskkill //PID <pid>; Mac: kill <pid>). Or by the port it listens on: netstat -ano | findstr :<port> (the PID ends the LISTENING line), or on the Mac kill $(lsof -t -iTCP:<port> -sTCP:LISTEN); a port Docker publishes belongs to Docker: stop the container instead`;
// a command word as a name: no quotes, no path, lower case, no .exe (C:\Windows\System32\taskkill.exe is taskkill)
// (a leading ! too: herdr agent prompt w1 "!pkill node" runs pkill in that session)
const cmdName = (raw) => raw.replace(/["']/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '').replace(/^!/, '');
const KILL_WORDS = new Set(['stop-process', 'spps', 'kill', 'taskkill', 'killall', 'pkill', 'remove-ciminstance', 'terminate',
  'get-process', 'gps', 'ps', 'pgrep', 'pidof', 'tasklist', 'win32_process', 'wmic', 'lsof']);
const OTHER_TOOL = new Set(['docker', 'podman', 'nerdctl', 'kubectl', 'compose', 'pm2']); // docker ps, docker kill
const PS_BEFORE = new Set(['sudo', '$', 'xargs', 'exec', 'command', 'nohup', 'time', 'env']); // ps as the command
const NOT_RUN = new Set(['which', 'man', 'type', 'whereis', 'where', 'get-command', 'gcm', 'get-help', 'help', 'tldr']); // which pkill
const ARGS = 64; // a command's arguments are read this far: one pass over the words, not one per word
// pkill / pgrep limited to this shell's processes: a pid file (-F) or a parent PID (-P $$). A pattern is not enough:
// pkill -f relay.ts matches every session's relay, and the killer's own shell holds the pattern too.
// (-P 1 is not narrow: detached processes, relays among them, have parent 1)
const parentOk = (p) => p === '$$' || (/^\d+$/.test(p ?? '') && p !== '1');
const narrow = (args) => args.some((a, k) => /^(?:-F|--pidfile)(?:=|$)/.test(a)
  || (/^(?:-P|--parent)$/.test(a) && parentOk(args[k + 1])) || parentOk(/^(?:-P|--parent=)(.+)$/.exec(a)?.[1]));
// options whose next word is their value, not a PID: PowerShell's common ones (-ea 0, -ErrorAction SilentlyContinue,
// -OutBuffer 1), -InputObject, kill -s 9 / -n 9, taskkill /S /U /P
const VALUE_OPT = /^(?:-(?:ea|ev|wa|wv|ov|ob|pv|iv|infa|proga|erroraction|errorvariable|warningaction|warningvariable|outvariable|outbuffer|pipelinevariable|informationaction|informationvariable|progressaction|inputobject|s|n)|(?:\/\/?|-)(?:s|u|p))$/i;
// a stop that names its PIDs (Stop-Process -Id 1234 -ErrorAction SilentlyContinue, -Id:1234, kill -s TERM 1234,
// taskkill /PID 1234 /F): option values skipped, every other word a PID or a switch, at least one PID
function literalPids(args) {
  let pids = 0;
  for (let k = 0; k < args.length; k++) {
    const x = args[k];
    if (/^-id:\d+(?:,\d*)*$/i.test(x)) pids++;
    else if (x === '@') continue; // -Id @(1234,5678)
    else if (VALUE_OPT.test(x)) k++;
    else if (/^(?:-|\/\/?[a-z])/i.test(x)) continue; // a switch: -Force, -9, /F
    else if (/^\d+(?:,\d*)*$/.test(x)) pids++;
    else return false;
  }
  return pids > 0;
}

// Fails closed like the patterns: a command word anywhere counts, and a quoted command (powershell "...", ssh host '...',
// "$(pgrep node)") is read as a command too. Blocks a kill that names the image (Stop-Process -Name, taskkill /IM or a
// filter other than PID eq, killall, pkill), and a by-name lookup feeding a stop that does not name its PIDs: the lookup
// earlier in the command (Get-Process node | Stop-Process, $p = Get-Process node; $p | Stop-Process) or inside the
// stop's arguments (kill $(pgrep node), Stop-Process -Id (Get-Process node).Id). A lookup after the stop is a check
// (kill $PID; ps aux | grep mock). Get-Process -Id and ps -p are not by-name lookups. text has had its messages
// stripped already (check).
function killByName(text) {
  const joined = text.replace(/`\r?\n/g, ' ').replace(/\\\r?\n/g, ' ').replace(/`/g, ' $ ');
  return scanKills(joined, { lookup: false, stop: false }, false);
}

// a single-clause ProcessId filter names one process: -Filter "ProcessId=1234", where processid=1234 (not "... OR ProcessId=1")
const oneProcess = (w) => w.some((x) => /^\s*processid\s*=\s*\S+\s*$/i.test(x));
const RUNS_NEXT = new Set(['c', 'k', '-c', '-command']); // cmd /c "taskkill" ..., bash -c, pwsh -Command: the next word runs
const TERMINATE_AFTER = new Set(['-methodname', '-name', 'call', '=', 'methodname']); // Invoke-CimMethod -Name Terminate, splats

// seen.lookup / seen.stop: a by-name lookup, or a stop, came earlier in the command; inArgs: this text is inside a
// stop's arguments
function scanKills(text, seen, inArgs) {
  for (const seg of text.match(SEGMENT) ?? []) {
    const raw = seg.match(WORD) ?? [];
    const w = raw.map(unquote);
    const name = raw.map(cmdName);
    let argsEnd = -1; // the last word of a stop's arguments in this segment
    for (let i = 0; i < w.length; i++) {
      const args = inArgs || i <= argsEnd;
      if (/["']/.test(raw[i]) && /[\s;&|]/.test(w[i]) && scanKills(stripMessages(w[i]), seen, args)) return true;
      const n = name[i], prev = name[i - 1];
      // CIM/WMI Terminate, quoted or not: Invoke-CimMethod -MethodName "Terminate", -Name Terminate, @{ MethodName = 'Terminate' }
      if (n === 'terminate' && TERMINATE_AFTER.has(prev)) { if (seen.lookup) return true; seen.stop = true; continue; }
      // a quoted word is an argument (Select-String "kill"), unless it is the command: & 'taskkill' /IM node.exe
      if (/^["']/.test(raw[i]) && i > 0 && !PS_BEFORE.has(prev) && !RUNS_NEXT.has(prev)) continue;
      if (!KILL_WORDS.has(n) && !/\.(?:kill|terminate|foreach)$/.test(n) && !n.includes('getprocessesbyname')) continue;
      if (NOT_RUN.has(prev) || (prev === '-v' && name[i - 2] === 'command')) continue; // which pkill, command -v pkill
      let rest = w.slice(i + 1, i + 1 + ARGS);
      const cut = rest.findIndex((x) => /^\d*[<>&]/.test(x)); // a redirection ends the arguments
      if (cut >= 0) rest = rest.slice(0, cut);
      if (/^--(?:help|version)$/.test(rest[0] ?? '') || rest.some((x) => /^-whatif(?::\$true)?$/i.test(x))) continue;
      if ((n === 'stop-process' || n === 'spps') && rest.some((x) => /^-(?:n|processn)[a-z]*(?::|$)/i.test(x))) return true;
      // PowerShell's kill is Stop-Process: kill -n node is -Name; bash's kill -n takes a signal number
      if (n === 'kill' && rest.some((x, k) => /^-(?:name|processname)(?::|$)/i.test(x) || (/^-n[a-z]*$/i.test(x) && !/^\d+$/.test(rest[k + 1] ?? '')))) return true;
      if (n === 'taskkill' && rest.some((x, k) => /^(?:\/\/?|-)im$/i.test(x)
        || (/^(?:\/\/?|-)fi$/i.test(x) && !/^\s*pid\s+eq\s+(?:\d+|\$\w+)\s*$/i.test(rest[k + 1] ?? '')))) return true;
      if (n === 'killall' || (n === 'pkill' && !narrow(rest))) return true;
      // kill -9 -1, kill -- -1: every process you own (kill -1 1234 is SIGHUP to 1234)
      if (n === 'kill' && rest.some((x, k) => k > 0 && x === '-1' && !/^-[sn]$/.test(rest[k - 1]))) return true;
      const byId = rest.some((x) => /^(?:-id|-p|--pid|-q)(?::|=|$)/i.test(x) || (n === 'ps' && /^-[a-zA-Z]*p\d*$/.test(x))); // ps -fp $PID
      const lookup = ((n === 'get-process' || n === 'gps' || (n === 'ps' && (prev === undefined || PS_BEFORE.has(prev)))) && !byId)
        || (n === 'pgrep' && !narrow(rest)) || n === 'pidof' || n === 'tasklist'
        || (n === 'win32_process' && !oneProcess(w)) || (n === 'wmic' && /^process$/i.test(rest[0] ?? '') && !oneProcess(w))
        || (n === 'lsof' && rest.some((x) => /^-c/.test(x))) // lsof -c node
        || n.includes('getprocessesbyname');
      // inside a stop's arguments, or fed to an earlier stop's input: xargs kill < <(pgrep node), done < <(pgrep node)
      if (lookup) { if (args || (seen.stop && w.slice(0, i).includes('<'))) return true; seen.lookup = true; }
      const stop = ((n === 'stop-process' || n === 'spps' || n === 'taskkill' || n === 'remove-ciminstance'
        || (n === 'kill' && !OTHER_TOOL.has(prev))) && !literalPids(rest))
        || /\.(?:kill|terminate)$/.test(n)
        || (/\.foreach$/.test(n) && /^(?:kill|terminate)$/i.test(w[i + 1] ?? '')) // (Get-Process node).ForEach('Kill')
        || (n === 'wmic' && rest.some((x) => /^delete$/i.test(x)))
        // a pid file or parent the shell fills in: pkill -F <(pgrep node); its arguments run to the segment's end
        || (n === 'pkill' && w.slice(i + 1, i + 1 + ARGS).some((x) => x === '<' || (x.includes('$') && x !== '$$')));
      if (stop) {
        if (seen.lookup) return true;
        seen.stop = true;
        // to the window's end, past a redirection: kill 2>/dev/null $(pgrep node)
        argsEnd = Math.max(argsEnd, n === 'pkill' ? w.length : Math.min(w.length - 1, i + ARGS));
      }
    }
  }
  return false;
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
      if (!/(?:^!?|\/)git(?:\.exe)?$/.test(w[i])) continue; // !git: a herdr prompt "!git push ..." runs it there
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
