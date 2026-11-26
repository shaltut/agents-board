// Guard core (#4002): one fail-closed rule set for an agent's shell commands, file edits and ask-user tool, keyed by role.
// Pure ES module: no I/O, no imports, no dependencies. A thin per-CLI shim (shim-claude.mjs) reads the hook input and
// CB_ROLE / CB_PROTECTED_BRANCHES / CB_ALLOW_ASK from its pane, calls evaluate, and prints the CLI's block format.
// Deploy with node kit/guard/install.mjs (it copies this file with its shims and probes them); never copy one file alone.
//
// Shell commands: it ignores message text (cb tell, git commit -m, gh --body, quoted-delimiter heredoc bodies written to
// files), so "the shutdown is planned" can be posted. What is left is matched ANYWHERE, like the old hook: a fence fails
// closed (ssh host reboot, nohup, xargs ...). Text the shell would expand ("$(...)", backticks, unquoted heredocs) is
// never stripped.

export const ROLES = Object.freeze(['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator']);
// read and report: no edits, commits or pushes (Q2799: architect and owner keep Edit/Write)
export const READ_ONLY_ROLES = Object.freeze(['reviewer', 'qa', 'investigator']);

const QUOTED = String.raw`"(?:\\.|[^"\\])*"|'[^']*'`;
// A message command plus its same-line args: quoted runs, escaped pairs or bare words (stops at ; & | newline).
const MESSAGE_HEAD = String.raw`\bcb[ \t]+(?:tell|ask|log|add|done|move|fail|pass|edit)\b|\bgit[ \t]+commit\b|\bgh[ \t]+pr[ \t]+(?:create|comment|review)\b|\bherdr(?:[ \t]+--machine[ \t]+\S+)?[ \t]+agent[ \t]+prompt\b`;
const MESSAGE_CMD = new RegExp(String.raw`(${MESSAGE_HEAD})((?:[ \t]+(?:${QUOTED}|\\.|[^\s;&|"'\\])+)*)`, 'g');
// Only a quoted-delimiter heredoc is literal; an unquoted <<EOF body is expanded by the shell. A header line holds <<'ID'
// or <<"ID" (<<- too); its body runs to the first later line holding only ID (blanks around it allowed), never the line
// right after the header. One pass (#4002): the regex form, /^([^\n]*<<-?[ \t]*(['"])(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3
// [ \t]*(?=\n|$)/gm, searched to the end of the text again for every header without its end line ((headers x length):
// 4 s on 156 KB through a role seat's six scans). Same matches: end lines are indexed once per word, a line's << are
// tried last to first (the regex's greedy [^\n]*), and ^ and $ keep the m flag's line ends (\n, \r, U+2028, U+2029).
const END_LINE = /\n[ \t]*(\w+)[ \t]*(?=\n|$)/gm; // a line holding only a word, from the \n before it
const HEADER_AT = /<<-?[ \t]*(['"])(\w+)\1/y;
const LINE_START = /^/gm;
function replaceHeredocs(text, fn) {
  const ends = new Map(); // word -> { at: [[index of the \n before the line, end of the line's word and blanks], ...], k }
  for (const m of text.matchAll(END_LINE)) {
    const e = ends.get(m[1]) ?? { at: [], k: 0 };
    e.at.push([m.index, m.index + m[0].length]);
    ends.set(m[1], e);
  }
  let out = '';
  let pos = 0;
  for (let s = 0; ;) {
    const nl = text.indexOf('\n', s);
    if (nl < 0) break;
    const line = text.slice(s, nl);
    let found = null;
    for (let at = line.lastIndexOf('<<'); at >= 0 && !found; at = at > 0 ? line.lastIndexOf('<<', at - 1) : -1) {
      HEADER_AT.lastIndex = at;
      const h = HEADER_AT.exec(line);
      const e = h && ends.get(h[2]);
      if (!e) continue;
      while (e.k < e.at.length && e.at[e.k][0] <= nl) e.k++; // its \n must come after the header's own
      if (e.k < e.at.length) found = { id: h[2], end: e.at[e.k][1] };
    }
    // no match from here: a later ^ on this line (after \r) only reaches some of the same <<, so none matches either
    if (!found) { s = nl + 1; continue; }
    out += text.slice(pos, s) + fn(text.slice(s, found.end), line, found.id);
    pos = found.end;
    LINE_START.lastIndex = pos;
    const next = LINE_START.exec(text);
    if (!next) break;
    s = next.index;
  }
  return out + text.slice(pos);
}
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
  return replaceHeredocs(cmd, (all, line, id) => (writesText(line) ? `${line}\n${id}` : all))
    .replace(MESSAGE_CMD, (_all, head, args) =>
      // kept: a "$(...)" or backtick the shell runs, and a herdr prompt starting with ! (it runs as a shell command there)
      head + args.replace(new RegExp(QUOTED, 'g'), (q) =>
        ((/^herdr/.test(head) && /^["']!/.test(q)) || (/^"/.test(q) && /\$\(|`/.test(q)) ? q : '""')));
}

// PowerShell and cmd (#4002): a recursive delete whose target is a root, a drive root or the home folder. The command,
// its recursion flag and its target sit in one command segment (stops at ; & | newline), in any order (Remove-Item ~
// -Recurse). The target is a whole word, quoted or not, so rm -rf *, Remove-Item -Recurse -Force dist, dist/ and
// C:\w\dist pass. Each part is one linear test per segment: a lookahead per command word would be quadratic, and a
// long command must not run past the hook's timeout.
// A backslash before a newline (bash's line continuation) or before ; & | (bash's escaped character: find -exec rm
// -rf {} \;) is the shell's, not a \ root: joined or replaced before the split, as is PowerShell's ` continuation. The
// cost: a PowerShell \ root with more lines after it is not seen (a \ that ends the command still blocks).
const SHELL_ESCAPES = (text) => text.replace(/[\\`]\r?\n/g, ' ').replace(/\\[;&|]/g, '_');
const inOneSegment = (...parts) => {
  const res = parts.map((p) => new RegExp(p, 'i'));
  return { test: (text) => SHELL_ESCAPES(text).split(/[;&|\n]/).some((seg) => res.every((re) => re.test(seg))) };
};
const ROOT = String.raw`(?:[/\\]\*?|[a-z]:(?:[/\\]\*?)?|(?:~|\$home|\$env:userprofile)(?:[/\\]\*?)?)`;
const ROOT_ARG = String.raw`[ \t,]["']?${ROOT}["']?(?=[\s,)]|$)`;
const DRIVE_ARG = String.raw`[ \t]["']?(?:[a-z]:(?:[/\\]\*?)?|\\\*)["']?(?=[\s)]|$)`;
const RECURSE = String.raw`[ \t](?:-[fvi]*r[fvi]*|-re(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?|--recursive|/{1,2}s)(?::\$true)?(?=[\s)]|$)`;
const SLASH_S = String.raw`[ \t]/{1,2}s(?=[\s)"']|$)`;

// Linear forms of the base rules shaped /first[^;&|\n]*then/ (or /first.*then/, one line): the first match of first in
// each piece, then one search for then after it. Same answer (a later match of first only sees less of its piece), but
// such a regex rescans the piece from every match of first: 4 s on 40,000 "mv" words, minutes on "git push" repeated,
// and a hook that runs past its timeout is the one way a fail-closed guard still fails open.
const SEGMENTS = /[^;&|\n]+/g;
const LINES = /.+/g; // the reach of .* : up to a line terminator
const thenLater = (pieces, first, then) => {
  const a = new RegExp(first, 'i');
  const b = new RegExp(then, 'i');
  return { test: (text) => (text.match(pieces) ?? []).some((s) => { const m = a.exec(s); return m !== null && b.test(s.slice(m.index + m[0].length)); }) };
};
// git ... push in one segment, then after that push main or master and a force flag (or a +refspec naming main/master)
const MAIN_WORD = /\b(?:main|master)\b/i;
const FORCE_FLAG = /--force|[ \t]-[a-z]*f[a-z]*\b/i;
const forcesMain = (rest) => MAIN_WORD.test(rest)
  && (FORCE_FLAG.test(rest) || rest.split(/\s+/).some((t) => t.includes('+') && MAIN_WORD.test(t.slice(t.indexOf('+') + 1))));
const FORCE_PUSH_MAIN = { test: (text) => (text.match(SEGMENTS) ?? []).some((seg) => {
  const g = /\bgit\b/i.exec(seg);
  const p = g && /\bpush\b/i.exec(seg.slice(g.index + 3));
  return !!p && forcesMain(seg.slice(g.index + 3 + p.index + 4));
}) };
// a download, the first | after it in its ; & newline segment, then iex: the parts between pipes
const DOWNLOAD = /(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget)\b/i;
const TO_IEX = /^[ \t]*(?:Invoke-Expression|iex)\b/i;
const DOWNLOAD_TO_IEX = { test: (text) => text.split(/[;&\n]/).some((seg) => {
  const parts = seg.split('|');
  return parts.some((part, k) => k + 1 < parts.length && TO_IEX.test(parts[k + 1]) && DOWNLOAD.test(part));
}) };
// rm, then its option words (each -[a-z-]+, read one way), one of them recursive, then a / ~ target. The base regex,
// \brm[ \t]+(?:--?[a-z-]+[ \t]+)*(?:-[a-z]*r[a-z]*|--recursive)(?:[ \t]+--?[a-z-]+)*[ \t]+ then the target, read --a two
// ways (rm --a --a ...: 2^n) and retried every rm inside an option run (-rm -rm ...: count x length). Here each run is
// read once: an rm start inside it (-rm) ends at the same word with a subset of its flags, so it cannot match either.
const RM_RUN = /\brm[ \t]+((?:-[a-z-]+[ \t]+)*)/gi;
const RECURSIVE_WORD = /^(?:-[a-z]*r[a-z]*|--recursive)$/i;
const ROOT_TARGET = /["']?(?:\/\*?|~(?:\/\.?\*)?\/?)(?=["'\s;&|)]|$)/iy;
const RM_ROOT = { test: (text) => {
  for (const m of text.matchAll(RM_RUN)) {
    if (!m[1] || !m[1].split(/[ \t]+/).some((x) => RECURSIVE_WORD.test(x))) continue;
    ROOT_TARGET.lastIndex = m.index + m[0].length;
    if (ROOT_TARGET.test(text)) return true;
  }
  return false;
} };

const PATTERNS = [
  // recursive rm (any flag order, -r/-R/--recursive, with or without -f; a non-TTY rm -r never prompts);
  // the target is a bare / /* ~ ~/ ~/* ~/.* (also quoted), not ~/tmp/x
  ['rm -rf /', RM_ROOT],
  ['mkfs.', String.raw`\bmkfs\.`],
  ['dd of=/dev/', thenLater(LINES, String.raw`\bdd[ \t]+if=`, String.raw`\bof=/dev/`)], // was \bdd[ \t]+if=.*\bof=/dev/
  ['fork bomb', String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`],
  ['chmod -R 777 /', String.raw`\bchmod[ \t]+-R[ \t]+777[ \t]+/`],
  // one command segment: "git mv a b && x > /dev/null" is fine (was \bmv[ \t][^;&|\n]*[ \t]/dev/null)
  ['mv to /dev/null', thenLater(SEGMENTS, String.raw`\bmv[ \t]`, String.raw`[ \t]/dev/null`)],
  // was \b(?:wget|curl)[ \t].*\|[ \t]*(?:sudo[ \t]+)?(?:ba)?sh\b
  ['pipe to shell', thenLater(LINES, String.raw`\b(?:wget|curl)[ \t]`, String.raw`\|[ \t]*(?:sudo[ \t]+)?(?:ba)?sh\b`)],
  // a power-off word as a command or argument, not inside a file name (graceful-shutdown.ts, shutdown.test.ts)
  // (a trailing dot is a file name unless it is .exe or .target: shutdown.exe, reboot.target)
  ['shutdown', String.raw`(?<![\w.-])shutdown(?![\w/-])(?!\.(?!(?:exe|target)\b))`],
  ['reboot', String.raw`(?<![\w.-])reboot(?![\w/-])(?!\.(?!(?:exe|target)\b))`],
  ['init 0/6', String.raw`\binit[ \t]+[06]\b`],
  ['format c:', String.raw`\bformat[ \t]+c:`],
  ['del c:', String.raw`\bdel[ \t]+/f[ \t]+/s[ \t]+/q[ \t]+c:`],
  // one segment only (was \bgit\b[^;&|\n]*\bpush\b(?=[^;&|\n]*(?:--force|[ \t]-[a-z]*f[a-z]*\b|\+\S*\b(?:main|master)\b))
  // (?=[^;&|\n]*\b(?:main|master)\b))
  ['git push --force main', FORCE_PUSH_MAIN],
  ['git reset --hard', thenLater(SEGMENTS, String.raw`\breset\b`, String.raw`--hard\b`)], // was \breset\b[^;&|\n]*--hard\b
  ['> /dev/sda', String.raw`>[ \t]*/dev/sd[a-z]`],
  ['--no-preserve-root', String.raw`--no-preserve-root`],
  ['drop database', String.raw`\bdrop[ \t\n]+database\b`],
  ['drop table', String.raw`\bdrop[ \t\n]+table\b`],
  // PowerShell and cmd (#4002)
  ['cmd del/rd /s on a drive root', inOneSegment(String.raw`(?<![\w.-])(?:del|rd|rmdir)(?![\w.-])`, SLASH_S, DRIVE_ARG)],
  ['recursive Remove-Item on a root, drive or home folder',
    inOneSegment(String.raw`(?<![\w.-])(?:remove-item|ri|rd|rmdir|del|erase|rm)(?![\w.-])`, RECURSE, ROOT_ARG)],
  ['Stop-Computer', String.raw`(?<![\w-])stop-computer(?![\w-])`],
  ['Restart-Computer', String.raw`(?<![\w-])restart-computer(?![\w-])`],
  ['disk wipe (Format-Volume, Clear-Disk, Initialize-Disk, Remove-Partition)', String.raw`(?<![\w-])(?:format-volume|clear-disk|initialize-disk|remove-partition)(?![\w-])`],
  // was (?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget)\b[^;&|\n]*\|[ \t]*(?:Invoke-Expression|iex)\b
  ['download piped to Invoke-Expression', DOWNLOAD_TO_IEX],
].map(([name, re]) => [name, typeof re === 'string' ? new RegExp(re, 'i') : re]);

// Returns the name of the matched pattern, or null when the command is fine.
export function check(command) {
  const text = stripMessages(String(command ?? ''));
  return PATTERNS.find(([, re]) => re.test(text))?.[0] ?? (killByName(text) ? KILL_BY_NAME : null);
}

// Kill by process name (#3809): a name stops every process that has it, other sessions' too. On 24 Nov one session's
// Get-Process node | Stop-Process killed the PC's job runner, its supervisor and every session's relay, twice.
// (pwsh 7.6 preview on the PC cannot load CIM, so its list and port commands run in Windows PowerShell or netstat)
const KILL_BY_NAME = `kill by process name: it stops every process with that name on this machine, other sessions' too (node: the board runner, supervisor and relays). A lookup by name (Get-Process node, pgrep, ps | grep, Win32_Process) feeding a stop counts too. Stop only yours, by PID: note it when you start the process (Start-Process -PassThru, or $! in bash), or list them with their command lines and pick yours (Git Bash: powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Format-List ProcessId, CommandLine"; in Windows PowerShell the inner command alone; from pwsh wrap it in powershell -NoProfile { ... }; Mac: pgrep -fl node), then stop it in the next command: Stop-Process -Id <pid> (Git Bash: taskkill //PID <pid>; Mac: kill <pid>). Or by the port it listens on: netstat -ano | findstr :<port> (the PID ends the LISTENING line), or on the Mac kill $(lsof -t -iTCP:<port> -sTCP:LISTEN); a port Docker publishes belongs to Docker: stop the container instead`;
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
const oneProcess = (w) => w.some((x) => /^\s*processid\s*=\s*\S+\s*$/i.test(x))
  || (/\bprocessid\s*=\s*\d+\b/i.test(w.join(' ')) && !/\b(?:or|and)\b/i.test(w.join(' '))); // where ProcessId = 1234
// a segment for kills also ends at a brace: a stop's arguments never run into the next block (if/else, try/catch)
const KILL_SEGMENT = new RegExp(String.raw`(?:${QUOTED}|\\.|[^;&|\n{}"'\\])+`, 'g');
// cmd /c "taskkill" ..., bash -c, pwsh -Command: after a shell, the next word runs (grep -c "kill" is grep's)
const RUNS_NEXT = new Set(['c', 'k', '-c', '-command']);
const SHELLS = new Set(['cmd', 'bash', 'sh', 'zsh', 'pwsh', 'powershell']);
const TERMINATE_AFTER = new Set(['-methodname', '-name', 'call', '=', 'methodname']); // Invoke-CimMethod -Name Terminate, splats

// seen.lookup / seen.stop: a by-name lookup, or a stop, came earlier in the command; inArgs: this text is inside a
// stop's arguments
function scanKills(text, seen, inArgs) {
  for (const seg of text.match(KILL_SEGMENT) ?? []) {
    const raw = seg.match(WORD) ?? [];
    const w = raw.map(unquote);
    const name = raw.map(cmdName);
    let argsEnd = -1; // the last word of a stop's arguments in this segment
    // once per segment, not once per word (#4002: per word, both re-read the whole segment: 200 KB took 7 to 16 s)
    let one; // oneProcess(w): the segment's ProcessId filter names one process
    const isOne = () => (one ??= oneProcess(w));
    let fed = false; // an earlier word is a < that feeds stdin: < <(...) or done < ...
    for (let i = 0; i < w.length; i++) {
      if (i > 0 && w[i - 1] === '<' && (w[i - 2] === '<' || name[i - 2] === 'done')) fed = true;
      const args = inArgs || i <= argsEnd;
      if (/["']/.test(raw[i]) && /[\s;&|]/.test(w[i]) && scanKills(stripMessages(w[i]), seen, args)) return true;
      const n = name[i], prev = name[i - 1];
      // CIM/WMI Terminate, quoted or not: Invoke-CimMethod -MethodName "Terminate", -Name Terminate, @{ MethodName = 'Terminate' }
      // (-MethodName:Terminate too); its arguments, like any stop's, hold its source: -MethodName Terminate -Query "..."
      if ((n === 'terminate' && TERMINATE_AFTER.has(prev)) || /^(?:-(?:method)?name:|methodname=)terminate$/.test(n)) {
        if (seen.lookup) return true;
        seen.stop = true;
        argsEnd = Math.max(argsEnd, Math.min(w.length - 1, i + ARGS));
        continue;
      }
      // a quoted word is an argument (Select-String "kill"), unless it is the command: & 'taskkill' /IM node.exe
      if (/^["']/.test(raw[i]) && i > 0 && !PS_BEFORE.has(prev) && !(RUNS_NEXT.has(prev) && SHELLS.has(name[i - 2]))) continue;
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
        || (n === 'win32_process' && !isOne()) || (n === 'wmic' && /^process$/i.test(rest[0] ?? '') && !isOne())
        || (n === 'lsof' && rest.some((x) => /^-c/.test(x))) // lsof -c node
        || n.includes('getprocessesbyname');
      // inside a stop's arguments, or fed to an earlier stop's input: xargs kill < <(pgrep node), done < <(pgrep node)
      // ... or -InputObject (Get-Process node) after a ForEach-Object { Stop-Process ... } block
      if (lookup) {
        if (args || (seen.stop && (prev === '-inputobject' || fed))) return true;
        seen.lookup = true;
      }
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
// Segments end at ; & | newline and at a brace outside quotes (#4002: a PowerShell script block { ... } is read on its
// own, so a push's arguments never run into the next block); words end at whitespace and ( ) { } outside quotes.
const SEGMENT = KILL_SEGMENT;
const WORD = new RegExp(String.raw`(?:${QUOTED}|\\.|[^\s(){}"'\\])+`, 'g');
// one layer of quoting off, as the shell does: "..." (\" \\ \$ \` inside unescaped), '...' as is, \x outside quotes.
// The regex is built once, and a word with no quote or backslash is returned as is (the replace would change nothing):
// every scan unquotes every word, so this is most of a scan's cost on a long command.
const UNQUOTE = new RegExp(String.raw`"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)`, 'g');
const unquote = (w) => (/["'\\]/.test(w)
  ? w.replace(UNQUOTE, (_all, dq, sq, esc) => (dq !== undefined ? dq.replace(/\\(["\\$`])/g, '$1') : sq ?? esc))
  : w);

// Which quoted words (holding a space or a separator) a scan reads as commands, one layer of quotes off.
// EVERY_QUOTED, for the dangerous and protected-branch scans and the role rules' main/master check: all of them (fail
// closed: echo "git push origin development" blocks). runnerArg, for the other role rules (#4002): only what a shell
// runs, so grep -rn "git push" docs and git log --grep "git commit" are text to a reviewer or a builder:
// - the argument of bash, sh, zsh or su -c; cmd /c or /k;
// - anything after pwsh or powershell (-c, -Command or a positional script), ssh, eval, xargs, iex or Invoke-Expression;
// - a herdr prompt starting with ! (it runs there);
// - any quoted text in a pipeline stage whose output goes on to a shell or iex (| sh, | sudo bash, | pwsh -, | cmd, | iex);
// - a double-quoted string the shell expands ("$(...)", `...`).
// Each is built once per segment (the earlier words' names become prefix flags, so a long segment stays linear) and
// answers for word i.
const EVERY_QUOTED = () => () => true;
const SHELL_C = new Set(['bash', 'sh', 'zsh', 'su']);
const RUNS_REST = new Set(['ssh', 'eval', 'xargs', 'iex', 'invoke-expression', 'pwsh', 'powershell']);
const PIPE_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'iex', 'invoke-expression']);
function runnerArg(raw, w, name, piped) {
  const seen = []; // seen[k]: which runners are among the names of words 0 .. k-1
  let s = { shellC: false, cmd: false, herdr: false, rest: false };
  for (const n of name) {
    seen.push(s);
    s = { shellC: s.shellC || SHELL_C.has(n), cmd: s.cmd || n === 'cmd', herdr: s.herdr || n === 'herdr', rest: s.rest || RUNS_REST.has(n) };
  }
  return (i) => {
    if (piped) return true;
    if (raw[i].includes('"') && /\$\(| \$ /.test(w[i])) return true; // " $ " is a backtick substitution (scanCommands)
    const flag = (w[i - 1] ?? '').toLowerCase();
    const before = seen[Math.max(0, i - 1)]; // the words before the flag
    if (/^-(?:[a-z]*c|co|com|comm|comma|comman|command)$/.test(flag) && before.shellC) return true;
    if (/^\/\/?[ck]$/.test(flag) && before.cmd) return true;
    if (/^["']!/.test(raw[i]) && seen[i].herdr) return true;
    return seen[i].rest;
  };
}

// A segment with more than this many words naming the scanned command (git, gh, az) is blocked, not read: each one's
// arguments run to the segment's end, so reading them all costs (count x length), and a check that runs past the hook's
// timeout lets the command through. No hand-typed command comes near it; the block tells the agent to split it.
const MAX_COMMANDS_PER_SEGMENT = 16;

// Calls fn(w, i) for every word i whose command name (cmdName of the raw word: C:\...\git.exe, GIT.EXE, !git) is in
// names; returns its first non-null. Message text is ignored (stripMessages); a line continuation joins its lines (bash
// \ and PowerShell `, #4002); a backtick substitution counts as $ (and its inner command stays a command); a quoted
// command (bash -c "...", ssh host '...') is read as a command too when quoted says so. Throws past
// MAX_COMMANDS_PER_SEGMENT (evaluate turns that into a block).
function scanCommands(cmd, names, fn, quoted = EVERY_QUOTED) {
  const text = stripMessages(String(cmd ?? '')).replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ').replace(/`/g, ' $ ');
  const segs = [...text.matchAll(SEGMENT)].map((m) => {
    const raw = m[0].match(WORD) ?? [];
    return { start: m.index, end: m.index + m[0].length, raw, name: raw.map(cmdName) };
  });
  // piped[k]: segment k's output goes on, through | or |& (not ||), to a stage a shell or iex runs.
  // into[k]: what is piped into segment k reaches one: ANY word of k names one (so env bash, command bash, sudo -u x bash,
  // exec, nohup and xargs bash -c all count, with no wrapper list; one pass over the words), or k is blank and a newline carries the pipeline on
  // (a pipe may end a line; a CRLF or trailing blanks leave a blank segment). An & right after > or < is a redirection
  // (2>&1), not a new command, so the segment before it shares the next one's flag.
  const piped = segs.map(() => false);
  const into = segs.map(() => false);
  for (let k = segs.length - 1; k >= 0; k--) {
    const gap = k + 1 < segs.length ? text.slice(segs[k].end, segs[k + 1].start) : null;
    into[k] = segs[k].name.some((n) => PIPE_RUNNERS.has(n)) || (segs[k].raw.length === 0 && /^\n+$/.test(gap ?? '') && into[k + 1]) ||
      // a brace ends a segment, not the stage: xargs -I{} bash -c {}
      (/^[{}]+$/.test(gap ?? '') && into[k + 1]);
    if (gap === null) continue;
    if (/^\|&?\n*$/.test(gap)) piped[k] = into[k + 1] || piped[k + 1];
    else if (gap === '&' && /[<>]$/.test(text.slice(segs[k].start, segs[k].end))) piped[k] = piped[k + 1];
  }
  for (const [k, { raw, name }] of segs.entries()) {
    const w = raw.map(unquote);
    const hits = name.filter((n) => names.has(n)).length;
    if (hits > MAX_COMMANDS_PER_SEGMENT) {
      throw new Error(`${hits} ${[...names].join('/')} commands in one command segment are more than the guard reads (${MAX_COMMANDS_PER_SEGMENT}): split the command`);
    }
    const isCommand = quoted(raw, w, name, piped[k]);
    for (let i = 0; i < w.length; i++) {
      if (/["']/.test(raw[i]) && /[\s;&|]/.test(w[i]) && isCommand(i)) {
        const inner = scanCommands(w[i], names, fn, quoted);
        if (inner) return inner;
      }
    }
    for (let i = 0; i < w.length; i++) {
      if (!names.has(name[i])) continue;
      const hit = fn(w, i);
      if (hit) return hit;
    }
  }
  return null;
}
const GIT = new Set(['git']);
// the index of git's subcommand: past git's own options (git -C <path> -c k=v push)
function gitSub(w, i) {
  let j = i + 1;
  while (j < w.length && w[j].startsWith('-')) j += GIT_OPT_ARG.has(w[j]) ? 2 : 1;
  return j;
}
// a push's words (remote, then refspecs) and options, from the word after push
function pushArgs(w, j) {
  const words = [], opts = [];
  let del = false;
  for (j++; j < w.length; j++) {
    const x = w[j];
    if (/^\d*[<>]/.test(x)) { if (/^\d*[<>]+$/.test(x)) j++; continue; } // a redirection, and its file when apart
    if (!x.startsWith('-')) { words.push(x); continue; }
    opts.push(x);
    if (x === '--delete' || /^-\w*d\w*$/.test(x)) del = true;
    else if (PUSH_OPT_ARG.has(x)) j++; // -o <value>; --push-option=<value> is one word
  }
  return { words, opts, del };
}
// each refspec's destination: dst of src:dst (:dst too), a bare src itself, and under --delete the word as given
const destination = (r, del) => { const s = r.replace(/^\+/, ''); return del || !s.includes(':') ? s : s.slice(s.lastIndexOf(':') + 1); };

// The protected branch a git push in cmd writes to, or null. A git ... push anywhere in a segment counts, like the
// patterns above, so it fails closed (echo git push origin development blocks). A branch the shell fills in ($B, $(...),
// backticks) cannot be checked: that word is returned, so it blocks too. So is a wildcard destination (refs/heads/*,
// develop*): it can write a protected branch.
export function protectedPush(cmd, list) {
  if (!list.length) return null;
  const hit = (b) => list.some((e) => (e.includes('*') ? globRe(e).test(b) : e === b));
  return scanCommands(cmd, GIT, (w, i) => {
    const j = gitSub(w, i);
    if (w[j] !== 'push') return null;
    const { words, del } = pushArgs(w, j);
    // the shell fills in a $ word: the branch is unknown here. The remote too: an unquoted $R can split into two words
    const filled = words.find((x) => x.includes('$'));
    if (filled) return filled;
    // the first word is the remote; each refspec's destination without a leading + or refs/heads/ (or heads/, which git
    // reads the same)
    for (const r of words.slice(1)) {
      const to = destination(r, del);
      if (to.includes('*')) return to; // a wildcard refspec writes every branch it matches: protected ones too (C11)
      const dst = to.replace(/^(?:refs\/)?heads\//, '');
      if (hit(dst)) return dst;
    }
    return null;
  });
}

// The block reason for a protectedPush hit.
function pushReason(branch) {
  return branch.includes('$')
    ? `git push to a branch the shell fills in (${branch}) while branches are protected: name the branch literally, e.g. git push -u origin feat/my-card`
    : branch.includes('*')
      ? `git push to a wildcard destination (${branch}) while branches are protected: push one branch by name, e.g. git push -u origin feat/my-card`
      : `git push to protected branch ${branch}: push your own branch and open a PR; the lead merges it`;
}

// Role rules (#4002), the same for every agent (they replace the push globs in kit/permissions/*.json):
// every role: main/master are protected; no force push, --mirror/--all, HEAD or @ as the destination, or a push that
// names no branch. Every role but the lead: no PR merges (gh pr merge; az repos pr complete, auto-complete or
// bypass-policy). Read-only roles: no commits and no pushes at all (and no edits, in evaluate).
const FORCE_OPT = /^(?:-[a-zA-Z]*f[a-zA-Z]*|--force(?:-with-lease|-if-includes)?(?:=.*)?)$/;
const EVERY_BRANCH_OPT = /^--(?:mirror|all|branches)$/;
const GH = new Set(['gh']);
const GH_OPT_ARG = /^(?:-R|--repo|--hostname)$/;
const AZ = new Set(['az']);
const AZ_OPT_ARG = /^(?:-o|--output|--query|--subscription)$/;
const MERGES_PR = (x) => /^(?:--status=)?completed?$/i.test(x) || /^--(?:auto-complete|bypass-policy)(?:=|$)/i.test(x);
const NAME_IT = 'e.g. git push -u origin feat/my-card';
const LEAD_MERGES = 'only the lead merges pull requests: open the PR and tell the lead (cb tell)';
const readsOnly = (role) => `a ${role} session reads and reports; post what you found on the board (cb log, cb tell)`;
// past a command's options (skipping the values of the ones in valueOpt) from index j
function pastOpts(w, j, valueOpt) {
  while (j < w.length && w[j].startsWith('-')) j += valueOpt.test(w[j]) ? 2 : 1;
  return j;
}

// The fence (#4345). A squad seat runs under bypassPermissions, so the guard's hook entry in ~/.claude/settings*.json
// (or a repo's .claude/settings*.json) and ~/.claude-board (the installed guard, the runner config) are all that stand
// between it and anything: no role writes them from a shell, and none runs the guard installer (it installs whatever
// guard its own checkout holds). Reading stays open. kit/permissions/<role>.json denies the same paths to Edit/Write.
// The whole command counts, not one segment, so `cd ~/.claude && echo x > settings.json` blocks too. Fail closed: any
// write word or redirection next to a fence path blocks, e.g. a copy out of it. Linear: a few single-pass tests.
const FENCE_PATH = /(?:^|[\s"'=:(\\/~])\.claude(?:-board)?(?=[\\/\s"';&|)>]|$)/i;
const FENCE_REDIRECT = /(?<!-)>(?!&|>?[ \t]*(?:\/dev\/null|\$null|nul)(?![\w/.\\-]))/;
const FENCE_WORDS = ['tee', 'cp', 'mv', 'rm', 'rmdir', 'ln', 'install', 'rsync', 'dd', 'truncate', 'touch', 'chmod', 'chown',
  'python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'new-item',
  'ni', 'remove-item', 'ri', 'del', 'erase', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move', 'rename-item', 'rni',
  'ren', 'clear-content', 'clc', 'mklink', 'robocopy', 'xcopy', 'icacls', 'takeown', 'attrib'];
const FENCE_WRITER = new RegExp(String.raw`(?<![\w.-])(?:${FENCE_WORDS.join('|')})(?![\w.-])`, 'i');
const IN_PLACE = thenLater(SEGMENTS, String.raw`(?<![\w.-])(?:sed|perl)(?![\w.-])`, String.raw`[ \t](?:-[a-z]*i|--in-place)`);
const GUARD_INSTALL = /(?:^|[\s"'\\/])install\.mjs(?![\w.-])/i;
const FENCE = 'the fence (#4345): ~/.claude/settings*.json, a repo\'s .claude/settings*.json and ~/.claude-board (the guard, the runner config) are Ahmed\'s, and a squad seat never writes them or runs the guard installer. Reading them is fine (cat, Get-Content, grep, without a redirection). A change there is his: cb ask';
// Stripping only removes text, so a raw command naming neither a fence path nor the installer cannot name one stripped:
// skip the second stripMessages (the costly step on big heredocs) for nearly every command.
function fenceWrite(command) {
  if (!FENCE_PATH.test(command) && !GUARD_INSTALL.test(command)) return null;
  const text = stripMessages(command);
  if (GUARD_INSTALL.test(text) && !(text.match(SEGMENTS) ?? []).every((s) => !GUARD_INSTALL.test(s) || /(?:^|[ \t])--check(?![\w-])/.test(s))) return FENCE;
  if (!FENCE_PATH.test(text)) return null;
  return FENCE_REDIRECT.test(text) || FENCE_WRITER.test(text) || IN_PLACE.test(text) ? FENCE : null;
}

// The reason a role may not run this shell command, or null. An unset or empty role: no role rules (a hand-started
// session); a role outside ROLES: blocked (evaluate checks that first). A quoted string is a command here only where a
// shell runs it (runnerArg), except for main/master: like the protected-branch scan, they read every quoted string, so
// a mention of pushing main (grep -rn "git push origin main" docs) blocks too.
export function checkRole(command, role) {
  if (!role) return null;
  if (!ROLES.includes(role)) return `unknown CB_ROLE "${role}"`;
  const fence = fenceWrite(String(command ?? ''));
  if (fence) return fence;
  const readOnly = READ_ONLY_ROLES.includes(role);
  const git = scanCommands(command, GIT, (w, i) => {
    const j = gitSub(w, i);
    if (readOnly && w[j] === 'commit') return `git commit: ${readsOnly(role)}`;
    if (w[j] !== 'push') return null;
    if (readOnly) return `git push: ${readsOnly(role)}`;
    const { words, opts, del } = pushArgs(w, j);
    if (opts.some((x) => FORCE_OPT.test(x)) || words.some((x) => x.startsWith('+'))) {
      return 'force push (-f, --force, --force-with-lease, --force-if-includes or a +refspec) rewrites a shared branch: push new commits instead';
    }
    if (opts.some((x) => EVERY_BRANCH_OPT.test(x))) return `git push ${opts.find((x) => EVERY_BRANCH_OPT.test(x))} writes every branch: push one branch by name, ${NAME_IT}`;
    if (words.length < 2) return `git push that names no branch (git's config picks one, maybe main): name it, ${NAME_IT}`;
    const head = words.slice(1).map((r) => destination(r, del)).find((d) => d === 'HEAD' || d === '@');
    if (head) return `git push to ${head} writes the current branch under its own name, maybe main: name the destination, e.g. git push origin HEAD:feat/my-card`;
    return null;
  }, runnerArg);
  if (git) return git;
  const branch = protectedPush(command, ['main', 'master']);
  if (branch) return pushReason(branch);
  if (role === 'lead') return null;
  const gh = scanCommands(command, GH, (w, i) => {
    let j = pastOpts(w, i + 1, GH_OPT_ARG);
    if (w[j] !== 'pr') return null;
    j = pastOpts(w, j + 1, GH_OPT_ARG);
    return w[j] === 'merge' ? `gh pr merge: ${LEAD_MERGES}` : null;
  }, runnerArg);
  if (gh) return gh;
  return scanCommands(command, AZ, (w, i) => {
    let j = pastOpts(w, i + 1, AZ_OPT_ARG);
    if (w[j] !== 'repos') return null;
    j = pastOpts(w, j + 1, AZ_OPT_ARG);
    if (w[j] !== 'pr') return null;
    j = pastOpts(w, j + 1, AZ_OPT_ARG);
    if (w[j] !== 'update' && w[j] !== 'create') return null;
    return w.slice(j + 1).some(MERGES_PR)
      ? `az repos pr ${w[j]} with complete, auto-complete or bypass-policy merges the pull request: ${LEAD_MERGES}` : null;
  }, runnerArg);
}

const ASK = `interactive ask-user tools (AskUserQuestion and the like) are disabled here: they stop this session until Ahmed answers, and he is often away.
Ask on Claude Board instead, then KEEP WORKING on something else:

  cb ask <project> "<question>" -o "<Label>=<why / tradeoff>" -o "<Label (Recommended)>=<why>" [-c "<context, markdown>"] [--multi]

- Give the same options and explanations you would have put in the ask tool. Options are required;
  --free (no options) only for a fact: a URL, a name, a number.
- Add --blocking -t <task id> only if that task truly cannot continue; it parks the task in Blocked.
- The answer arrives in this session by itself (cb relay); without a relay, check with \`cb pending\`. More: cb help ask`;

// One decision for one tool call. req: { tool: 'shell' | 'edit' | 'ask' | 'unknown'; command?; role?; protectedBranches?;
// allowAsk? }. Returns { allow: true } or { allow: false, kind, reason }: kind 'dangerous' (a dangerous command or a
// CB_PROTECTED_BRANCHES push), 'role' (a role rule), 'input' (unreadable input, unknown tool or role) or 'ask'. The
// shim words the reason for its CLI. It fails closed: anything it cannot read or decide blocks.
export function evaluate(req) {
  const block = (kind, reason) => ({ allow: false, kind, reason });
  try {
    const { tool, command, role = null, protectedBranches = [], allowAsk = false } = req ?? {};
    if (role !== null && role !== undefined && role !== '' && !ROLES.includes(role)) {
      return block('input', `unknown CB_ROLE ${JSON.stringify(role)}: a squad seat's role is one of ${ROLES.join(', ')}`);
    }
    if (tool === 'shell') {
      if (typeof command !== 'string') return block('input', 'guard could not read hook input (the command is not a string)');
      const danger = check(command);
      if (danger) return block('dangerous', danger);
      const branch = protectedPush(command, Array.isArray(protectedBranches) ? protectedBranches : []);
      if (branch) return block('dangerous', pushReason(branch));
      const byRole = checkRole(command, role);
      return byRole ? block('role', byRole) : { allow: true };
    }
    if (tool === 'edit') return READ_ONLY_ROLES.includes(role) ? block('role', `editing files: ${readsOnly(role)}`) : { allow: true };
    if (tool === 'ask') return allowAsk === true ? { allow: true } : block('ask', ASK);
    return block('input', `unrecognized tool (${JSON.stringify(tool) ?? 'none'})`);
  } catch (e) {
    return block('input', `guard error (${String(e?.message ?? e).slice(0, 200)})`);
  }
}
