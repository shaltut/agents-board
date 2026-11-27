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
// C:\work\dist pass. Each part is one linear test per segment: a lookahead per command word would be quadratic, and a
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
// -InputObject and its abbreviations down to -Inp (-In is ambiguous), colon-bound too: -Inp (...), -InputObject:(...)
const INPUT_OBJECT = /^-inp(?:u(?:t(?:o(?:b(?:j(?:e(?:c(?:t)?)?)?)?)?)?)?)?:?$/;
// built-in cmdlets whose -InputObject only reads or shows it (Format-Table -InputObject (Get-Process node) after a stop
// is a check). Any other cmdlet's -InputObject after a stop fails closed: ForEach-Object, Where-Object, Start-Job and
// Measure-Command run a block on it ($sb = { $input | Stop-Process }; Start-Job -ScriptBlock $sb -InputObject (...)).
// Names, not wildcards: function Out-Kill { ... } is a user's. Several run a -Property / -GroupBy block or an @{e=...}
// calculated property, so readsInput also needs no $ word in the arguments and no { right after the segment.
const READS_INPUT = /^(?:format-(?:table|list|wide|custom)|f[tlwc]|out-(?:file|string|null|host|default|gridview|printer)|measure-object|measure|select-object|select|get-member|gm|sort-object|sort|group-object|group|convertto-(?:json|csv|xml|html)|export-(?:csv|clixml)|write-output|write|echo|write-host|tee-object|tee|compare-object|compare)$/;
// a segment after a block's closing brace that starts another branch, or a do loop's condition: its words are not that
// block's arguments (Stop-Process -Id $id; do { Start-Sleep 1 } while (Get-Process node))
const DEFINES = new Set(['function', 'filter', 'set-alias', 'new-alias', 'sal', 'nal']);
const BRANCH = new Set(['else', 'elseif', 'catch', 'finally', 'while', 'until']);

// a stop's arguments end at a redirection
const stopArgs = (rest) => { const cut = rest.findIndex((x) => /^\d*[<>&]/.test(x)); return cut >= 0 ? rest.slice(0, cut) : rest; };
const dryRun = (rest) => rest.some((x) => /^-whatif(?::\$true)?$/i.test(x));
// a stop's options that name the image: Stop-Process -Name, kill -n node (PowerShell's kill is Stop-Process; bash's kill
// -n takes a signal number), taskkill /IM or a filter other than PID eq <number>, $name or ${name}; kill -9 -1,
// kill -- -1: every process you own (kill -1 1234 is SIGHUP to 1234)
function namesImage(n, rest) {
  if ((n === 'stop-process' || n === 'spps') && rest.some((x) => /^-(?:n|processn)[a-z]*(?::|$)/i.test(x))) return true;
  if (n === 'kill' && rest.some((x, k) => /^-(?:name|processname)(?::|$)/i.test(x) || (/^-n[a-z]*$/i.test(x) && !/^\d+$/.test(rest[k + 1] ?? '')))) return true;
  if (n === 'taskkill' && rest.some((x, k) => /^(?:\/\/?|-)im$/i.test(x)
    || (/^(?:\/\/?|-)fi$/i.test(x) && !/^\s*pid\s+eq\s+(?:\d+|\$\w+|\$\{\w+\})\s*$/i.test(rest[k + 1] ?? '')))) return true;
  return n === 'kill' && rest.some((x, k) => k > 0 && x === '-1' && !/^-[sn]$/.test(rest[k - 1]));
}

// seen.lookup / seen.stop: a by-name lookup, or a stop, came earlier in the command; seen.splat: a Terminate named in a
// hashtable (@{ MethodName = 'Terminate'; Query = ... }), whose query can come after it; inArgs: this text is inside a
// stop's arguments
function scanKills(text, seen, inArgs) {
  // the } that closes a ${...}, and whether the text before that ${ was a block's arguments or a stop's, and which stop
  // (they carry past the ${...})
  let dollarClose = -1, dollarAfter = false, lastAfter = false, dollarArgs = false, lastArgs = false;
  let dollarStop = null, lastStop = null;
  for (const m of text.matchAll(KILL_SEGMENT)) {
    const raw = m[0].match(WORD) ?? [];
    const w = raw.map(unquote);
    const name = raw.map(cmdName);
    let argsEnd = -1; // the last word of a stop's arguments in this segment
    let openStop = null; // the stop those arguments are for
    // once per segment, not once per word (#4002: per word, both re-read the whole segment: 200 KB took 7 to 16 s)
    let one; // oneProcess(w): the segment's ProcessId filter names one process
    const isOne = () => (one ??= oneProcess(w));
    // the segment's command, past an assignment ($r = Measure-Object ...), only reads its -InputObject
    let reads;
    const readsInput = () => (reads ??= (() => {
      const k = name.findIndex((x) => !x.startsWith('$') && x !== '=');
      return k >= 0 && !seen.defines && READS_INPUT.test(name[k]) && !w.slice(k + 1).some((x) => x.includes('$')) && text[m.index + m[0].length] !== '{';
    })());
    // right after a block's closing brace, not another branch: & { Stop-Process -Id $args } (Get-Process node).Id,
    // Invoke-Command { ... } -ArgumentList (...), ForEach-Object { ... } -InputObject (...). The } of a parameter
    // expansion is no block (echo "stopped ${pid}, left: $(pgrep -c node)"): after it, the text before its ${ decides
    // (& { Stop-Process -Id $ids } ${x} (Get-Process node).Id; & { Stop-Process -Id $ids; ${x}} (Get-Process node).Id)
    const afterDollar = text[m.index - 1] === '}' && m.index - 1 === dollarClose;
    const afterBlock = afterDollar ? dollarAfter : text[m.index - 1] === '}' && !BRANCH.has(name[0]);
    const inDollar = text[m.index - 1] === '{' && text[m.index - 2] === '$'; // this segment is the inside of ${...}
    if (inDollar) {
      dollarClose = text[m.index + m[0].length] === '}' ? m.index + m[0].length : -1;
      dollarAfter = lastAfter;
      dollarArgs = lastArgs;
      dollarStop = lastStop;
    }
    lastAfter = afterBlock;
    // a stop's arguments run on through a ${...} and past it (#4436): kill -9 ${MAIN_PID} $(pgrep -f relay),
    // Stop-Process -Id ${pid}, (Get-Process node).Id, kill ${x:-$(pgrep node)}. Only the single-segment ${name} counts
    // as closed (above); bash and PowerShell end a nested one differently, so any other } stays a block's close.
    const segArgs = inArgs || ((inDollar || afterDollar) && dollarArgs);
    const segStop = inDollar || afterDollar ? dollarStop : null;
    // ... its options too: taskkill //PID ${PID} //IM node.exe, Stop-Process -Id ${pid} -Name node, kill -s ${SIG} -1
    if (afterDollar && segStop) {
      const rest = stopArgs(['$', ...w.slice(0, ARGS)]);
      if (!dryRun(rest) && namesImage(segStop, rest)) return true;
    }
    let fed = false; // an earlier word feeds stdin: < <(...), done < ..., done <<< ... (a here-string, glued or not)
    let shell = false; // an earlier word of the segment is a shell: powershell -NoProfile -ExecutionPolicy Bypass -Command
    for (let i = 0; i < w.length; i++) {
      if (i > 0 && (((w[i - 1] === '<' || w[i - 1] === '<<<') && (w[i - 2] === '<' || name[i - 2] === 'done'))
        || (name[i - 1] === 'done' && w[i].startsWith('<<<')))) fed = true;
      const args = segArgs || i <= argsEnd;
      // a quoted here-string of a lookup is fed to the loop's earlier stop: done <<< "$(pgrep node)"
      if (/["']/.test(raw[i]) && /[\s;&|]/.test(w[i]) && scanKills(stripMessages(w[i]), seen, args || (fed && seen.stop))) return true;
      const n = name[i], prev = name[i - 1];
      // CIM/WMI Terminate, quoted or not: Invoke-CimMethod -MethodName "Terminate", -Name Terminate, @{ MethodName = 'Terminate' }
      // (-MethodName:Terminate too); its arguments, like any stop's, hold its source: -MethodName Terminate -Query "..."
      if ((n === 'terminate' && TERMINATE_AFTER.has(prev)) || /^(?:-(?:method)?name:|methodname=)terminate$/.test(n)) {
        if (seen.lookup) return true;
        seen.stop = true;
        if ((prev === '=' && name[i - 2] === 'methodname') || n === 'methodname=terminate') seen.splat = true;
        argsEnd = Math.max(argsEnd, Math.min(w.length - 1, i + ARGS));
        continue;
      }
      // a quoted word is an argument (Select-String "kill"), unless it is the command: & 'taskkill' /IM node.exe, or
      // the word after a shell's -c / -Command / /c, with the shell's options between (cmd /d /c "taskkill" /IM node.exe)
      if (/^["']/.test(raw[i]) && i > 0 && !PS_BEFORE.has(prev) && !(RUNS_NEXT.has(prev) && shell)) { shell ||= SHELLS.has(n); continue; }
      shell ||= SHELLS.has(n);
      if (DEFINES.has(n)) seen.defines = true; // function Format-Table { ... }, Set-Alias ft Stop-Process
      if (!KILL_WORDS.has(n) && !/\.(?:kill|terminate|foreach)$/.test(n) && !n.includes('getprocessesbyname')) continue;
      if (NOT_RUN.has(prev) || (prev === '-v' && name[i - 2] === 'command')) continue; // which pkill, command -v pkill
      const rest = stopArgs(w.slice(i + 1, i + 1 + ARGS));
      if (/^--(?:help|version)$/.test(rest[0] ?? '') || dryRun(rest)) continue;
      if (namesImage(n, rest)) return true;
      if (n === 'killall' || (n === 'pkill' && !narrow(rest))) return true;
      const byId = rest.some((x) => /^(?:-id|-p|--pid|-q)(?::|=|$)/i.test(x) || (n === 'ps' && /^-[a-zA-Z]*p\d*$/.test(x))); // ps -fp $PID
      const lookup = ((n === 'get-process' || n === 'gps' || (n === 'ps' && (prev === undefined || PS_BEFORE.has(prev)))) && !byId)
        || (n === 'pgrep' && !narrow(rest)) || n === 'pidof' || n === 'tasklist'
        || (n === 'win32_process' && !isOne()) || (n === 'wmic' && /^process$/i.test(rest[0] ?? '') && !isOne())
        || (n === 'lsof' && rest.some((x) => /^-c/.test(x))) // lsof -c node
        || n.includes('getprocessesbyname');
      // inside a stop's arguments, or fed to an earlier stop's input: xargs kill < <(pgrep node), done < <(pgrep node);
      // after the closing brace of a block that stops; the -InputObject of a cmdlet that may run a block on it
      // ($sb = { Stop-Process ... }; ForEach-Object $sb -InputObject (Get-Process node)), not of one that only reads it
      if (lookup) {
        if (args || (seen.stop && (fed || afterBlock || (INPUT_OBJECT.test(prev ?? '') && !readsInput())))) return true;
        if (seen.splat && n === 'win32_process') return true; // @{ MethodName = 'Terminate'; Query = "... Win32_Process ..." }
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
        openStop = n;
      }
    }
    const endsInArgs = argsEnd >= 0 && argsEnd >= w.length - 1; // the segment ends inside a stop's arguments
    lastArgs = segArgs || endsInArgs;
    lastStop = endsInArgs && openStop ? openStop : segStop;
  }
  return false;
}

// Protected branches (#3746): a squad session's pane carries CB_PROTECTED_BRANCHES (cb squad up), and a git push whose
// destination is one of them is blocked. Unset or empty: no check at all.
const GIT_OPT_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source']); // git -C <path> push
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
  return scanCommands(unbrace(cmd), GIT, (w, i) => {
    const j = gitSub(w, i);
    if (w[j] !== 'push') return hiddenPush(w, i, j, hit); // #4661 S1: git $S / an alias / subtree push
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

// #4638 (PR 99 review): spellings past the commit, push and merge rules, which read git's subcommand and gh pr merge.
// An alias renames a subcommand, so git -c alias.c=commit c commits and git -c alias.p=push p origin main pushes main
// unseen: every role, an alias or include (a file that can hold one) set for the call (-c, --config-env, GIT_CONFIG_*
// before git) or written to git config is blocked. send-pack and http-push push past git push's branch rules. A read-only
// role also writes no commit or ref by plumbing (commit-tree, update-ref, mktree, mktag, write-tree, fast-import,
// hash-object -w), and runs git only by its subcommands' own names where git is the command: an alias from a config
// file the guard cannot see (git ci) or a subcommand the shell fills in (git $SUB) blocks.
const ALIAS_KEY = /^(?:alias|include|includeif)\./i;
const CONFIG_NULL = /^(?:\/dev\/null|nul|\$null)$/i;
const RO_GIT_WRITES = new Set(['commit', 'commit-tree', 'update-ref', 'mktree', 'mktag', 'write-tree', 'fast-import']);
const ALIASES = 'an alias renames a git subcommand past the commit, push and merge rules: run git with the subcommand\'s own name';
// an assignment before git that sets an alias or include for the call: GIT_CONFIG_KEY_<n> or GIT_CONFIG_PARAMETERS naming
// one, or GIT_CONFIG / _GLOBAL / _SYSTEM pointing at a config file (other than the null device), which can hold one
function configEnvAlias(x) {
  const m = /^(GIT_CONFIG\w*)=(.*)$/is.exec(x);
  if (!m) return false;
  const k = m[1].toUpperCase();
  if (k === 'GIT_CONFIG_PARAMETERS' || /^GIT_CONFIG_KEY_\d+$/.test(k)) return /(?:^|['"\s])(?:alias|include|includeif)\./i.test(m[2]);
  return (k === 'GIT_CONFIG' || k === 'GIT_CONFIG_GLOBAL' || k === 'GIT_CONFIG_SYSTEM') && !CONFIG_NULL.test(m[2]);
}
// git's words w, git at i, its subcommand at j: the reason this call gets past the rules, or null
function gitHides(w, i, j, role) {
  for (let k = 0; k < i; k++) if (configEnvAlias(w[k])) return `${w[k].split('=')[0]} before git: ${ALIASES}`;
  for (let k = i + 1; k < j; k++) {
    const o = w[k];
    const cfg = o === '-c' || o === '--config-env' ? (w[k + 1] ?? '') : /^--config-env=/.test(o) ? o.slice(13) : null;
    if (cfg !== null && ALIAS_KEY.test(cfg)) return `git ${o.split('=')[0]} ${cfg.split('=')[0]}: ${ALIASES}`;
  }
  const runs = gitRuns(w, i, j, role); // #4661 L1: a setting or variable that runs a command
  if (runs) return runs;
  const sub = w[j];
  if (sub === undefined) return null;
  if (sub === 'config') {
    // git config [--global] alias.x <value>, git config set alias.x <value>: a key followed by a value is a write
    const pos = stopArgs(w.slice(j + 1)).filter((x) => !x.startsWith('-')); // to a redirection: --get alias.c 2>/dev/null reads
    if (pos.some((x, k) => ALIAS_KEY.test(x) && pos[k + 1] !== undefined)) return `git config writing an alias or include: ${ALIASES}`;
  }
  if (sub === 'send-pack' || sub === 'http-push') return `git ${sub} pushes past the branch rules: push with git push, ${NAME_IT}`;
  if (!READ_ONLY_ROLES.includes(role)) return null;
  if (RO_GIT_WRITES.has(sub) || (sub === 'hash-object' && w.slice(j + 1).some((x) => /^-[^-]*w/.test(x)))) return `git ${sub}: ${readsOnly(role)}`;
  // git as the command: first in its segment, or after assignments, launchers (sudo git ci) and $( (x=$(git ci))
  const atCommand = w.slice(0, i).every((x) => ASSIGNMENT.test(x) || LAUNCHERS.has(cmdName(x)) || SHELL_KEYWORD.has(x)) || /(?:^|=)\$$/.test(w[i - 1] ?? '');
  if (atCommand && !GIT_COMMANDS.has(sub.toLowerCase())) {
    return `git ${sub} is not a git command (an alias, or a word the shell fills in): a ${role} runs git subcommands by their own names; ${readsOnly(role)}`;
  }
  return null;
}

// gh api (#4638): a call that writes, by an explicit method other than GET or HEAD or by a body (-f, -F, --field,
// --raw-field, --input make gh send POST), merges (pulls/<n>/merge, merges), moves refs (git/refs) or commits (contents,
// update-branch) past gh pr merge: every role but the lead. A graphql query given inline with no mutation in it is a read.
// gh alias set / import renames a command (gh m for pr merge) the same way.
// gh api's options: the long ones taking a value, the boolean ones; a short flag bundles as pflag reads it (-iX PUT,
// -iXPUT, -X=PUT). An option it does not know is judged a write (fail closed: it may take a value and shift the endpoint).
const GH_API_LONG_VALUE = new Set(['--header', '--jq', '--template', '--hostname', '--cache', '--preview']);
const GH_API_LONG_BOOL = new Set(['--paginate', '--slurp', '--include', '--silent', '--verbose', '--allow-escape-sequences', '--help']);
const GH_WRITES = 'gh api that writes (a method other than GET, or -f/-F/--input fields, which make gh POST) can merge, move a branch or commit past the merge rule: read with GET, comment with gh pr comment or gh pr review, and ' + LEAD_MERGES;
function ghApiWrites(w, j) {
  let method = null, body = false, unseen = false, endpoint = null;
  const fields = [];
  for (let k = j + 1; k < w.length; k++) {
    const x = w[k];
    if (/^\d*[<>]/.test(x)) continue; // a redirection
    if (x.startsWith('--')) {
      const eq = x.indexOf('='), name = eq < 0 ? x : x.slice(0, eq);
      const val = () => (eq < 0 ? (w[++k] ?? '') : x.slice(eq + 1));
      if (name === '--method') method = val();
      else if (name === '--field' || name === '--raw-field') { body = true; fields.push(val()); }
      else if (name === '--input') { body = true; unseen = true; val(); }
      else if (GH_API_LONG_VALUE.has(name)) val();
      else if (!GH_API_LONG_BOOL.has(name)) return true;
      continue;
    }
    if (x.startsWith('-') && x.length > 1) {
      for (let c = 1; c < x.length; c++) {
        const letter = x[c];
        if (letter === 'i') continue; // --include, the one boolean short flag
        const rest = x.slice(c + 1).replace(/^=/, '');
        const val = rest !== '' ? rest : (w[++k] ?? '');
        if (letter === 'X') method = val;
        else if (letter === 'f' || letter === 'F') { body = true; fields.push(val); }
        else if (!'Hqtp'.includes(letter)) return true;
        break;
      }
      continue;
    }
    endpoint ??= x;
  }
  if (/^(?:https?:\/\/[^/]+(?:\/api)?)?\/?graphql$/i.test(endpoint ?? '')) {
    // a read only with its query readable here: given inline (not a file or stdin), not a value the shell fills in (no
    // { in it), and no mutation anywhere
    const query = fields.filter((f) => /^query=/i.test(f));
    return unseen || query.length === 0 || fields.some((f) => /=@/.test(f)) || query.some((f) => !f.includes('{'))
      || w.slice(j + 1).some((x) => /\bmutation\b/i.test(x));
  }
  return method !== null ? !/^(?:get|head)$/i.test(method) : body;
}

// #4661 (PR 107 review S1, L1, L2): more ways past the push, commit and merge rules.
// - S1, every role: a git call whose subcommand the shell fills in (S=push; git $S origin main) or that is no git command
//   (an alias already in a config file: git p origin main) and that names main/master or a protected branch later; git
//   subtree push to one; and any write to a git config file (.git/config, a worktree's config, ~/.gitconfig,
//   ~/.config/git/config, /etc/gitconfig), which can add an alias. A git setting or variable that runs a command which
//   pushes (git -c core.pager='git push origin HEAD:main' log) too.
// - L1, read-only roles: no git setting or variable that runs a command (core.pager and pager.* other than a plain pager
//   or a switch, core.sshCommand, core.editor, diff.external, textconv, filter, credential.helper, gpg.program, merge
//   drivers, fsmonitor, hooksPath; GIT_PAGER/PAGER other than a plain pager, GIT_EXEC_PATH, GIT_SSH*, GIT_EXTERNAL_DIFF,
//   GIT_EDITOR, EDITOR ...; --exec-path=<dir>), and no git subtree push, add, merge or pull.
// - L2, every role but the lead: gh extension install / upgrade / exec, a gh word that is no gh command (an installed
//   extension or an alias runs its own code: gh merge 5), gh repo sync <repo> (moves a branch on GitHub), gh workflow run.
// A brace group with no space in it outside quotes (${S}, gh's {owner}) is read without its braces by the git and gh
// scans, or the brace ends the segment and hides the words after it (git ${S} origin main).
const unbrace = (t) => String(t ?? '').replace(new RegExp(String.raw`${QUOTED}|\{([^\s{}"']*)\}`, 'g'), (m, inner) => inner ?? m);
// word i is the command: first in its segment, or after assignments, launchers (sudo git p) and $( (x=$(git p))
const isCommandWord = (w, i) => w.slice(0, i).every((x) => ASSIGNMENT.test(x) || LAUNCHERS.has(cmdName(x)) || SHELL_KEYWORD.has(x))
  || /(?:^|=)\$$/.test(w[i - 1] ?? '');
// protectedPush's test for a call that is not git push: the protected branch it names, or null
function hiddenPush(w, i, j, hit) {
  const sub = w[j];
  if (sub === undefined) return null;
  let from;
  if (sub === 'subtree') {
    from = w.indexOf('push', j + 1) + 1;
    if (from === 0) return null;
    const filled = w.slice(from).find((x) => x.includes('$'));
    if (filled) return filled;
  } else if ((isFilled(sub) || /[$`%]/.test(sub) || !GIT_COMMANDS.has(sub.toLowerCase())) && isCommandWord(w, i)) from = j + 1;
  else return null;
  for (const x of stopArgs(w.slice(from))) {
    if (x.startsWith('-')) continue;
    const to = destination(x, false).replace(/^(?:refs\/)?heads\//, '');
    if (hit(to)) return to;
  }
  return null;
}
const RUNS_ENV = /^(GIT_EXTERNAL_DIFF|GIT_SSH|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_ASKPASS|SSH_ASKPASS|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PROXY_COMMAND|EDITOR|VISUAL|GIT_PAGER|PAGER)=(.*)$/is;
const SWITCH = /^(?:true|false|yes|no|on|off|[01])?$/i;
// a config key whose value git runs as a command (alias and include are gitHides' own)
function keyRuns(key, value, isEnv) {
  if (/^core\.pager$/i.test(key)) return isEnv || !PAGER_OK.test(value);
  if (/^pager\./i.test(key)) return isEnv || !(PAGER_OK.test(value) || SWITCH.test(value));
  return !ALIAS_KEY.test(key) && (GIT_RUNS_KEY.test(key) || /\.driver$/i.test(key));
}
// git's words w, git at i, its subcommand at j: why a setting or variable that runs a command (or a read-only role's
// subtree write) may not run, or null
function gitRuns(w, i, j, role) {
  const found = []; // [setting, its value]
  for (let k = 0; k < i; k++) {
    const m = RUNS_ENV.exec(w[k]);
    if (m && !(/PAGER$/i.test(m[1]) && PAGER_OK.test(m[2]))) found.push([m[1], m[2]]);
  }
  for (let k = i + 1; k < j; k++) {
    const o = w[k];
    if (/^--exec-path=/i.test(o)) found.push(['--exec-path', o.slice(12)]);
    const isEnv = o === '--config-env' || /^--config-env=/.test(o);
    const cfg = o === '-c' || o === '--config-env' ? (w[k + 1] ?? '') : /^--config-env=/.test(o) ? o.slice(13) : null;
    if (cfg === null) continue;
    const eq = cfg.indexOf('='), key = eq < 0 ? cfg : cfg.slice(0, eq), value = eq < 0 ? '' : cfg.slice(eq + 1);
    if (keyRuns(key, value, isEnv)) found.push([key, isEnv ? '' : value]);
  }
  const push = found.find(([, v]) => /\bpush\b/i.test(v));
  if (push) return `${push[0]} runs a command that pushes, past the branch rules: push with git push, ${NAME_IT}`;
  if (!READ_ONLY_ROLES.includes(role)) return null;
  if (found.length) return `${found[0][0]} makes git run a command: ${readsOnly(role)}`;
  const write = w[j] === 'subtree' && w.slice(j + 1).find((x) => /^(?:push|add|merge|pull)$/.test(x));
  return write ? `git subtree ${write}: ${readsOnly(role)}` : null;
}
// a git config file as a path, any separator
const GIT_CONFIG_FILE = /(?:^|[\s"'=:(\\/~<>])(?:\.git[\\/]+(?:(?:worktrees|modules)[\\/]+[^\s"';&|)>]+[\\/]+)?config(?:\.worktree)?|\.gitconfig|\.config[\\/]+git[\\/]+config|gitconfig)(?=[\s"';&|)>`]|$)/i;
const GIT_CONFIG_WRITE = 'a write to a git config file (.git/config, ~/.gitconfig and the like) can add an alias or include that renames a git subcommand past the commit, push and merge rules: change a setting with git config (never alias.* or include.*); one that needs the file itself: cb ask';
// per segment, like the fence: the segment names a git config file and redirects into it or has a writer (not git: git
// config's own writes are gitHides'); the joined text is judged as well as the raw lines (rawAndJoined)
function gitConfigFileWrite(raw) { return rawAndJoined(gitConfigFileWriteOne)(raw); }
function gitConfigFileWriteOne(command) {
  if (!/config/i.test(command)) return null;
  const text = stripMessages(command).replace(URL_WORD, ' ').replace(NOCLOBBER, '> ');
  for (const seg of text.match(SEGMENTS) ?? []) {
    if (!GIT_CONFIG_FILE.test(seg)) continue;
    for (const m of seg.matchAll(REDIRECT_TARGET)) if (GIT_CONFIG_FILE.test(` ${m[1] ?? ''}`)) return GIT_CONFIG_WRITE;
    if (FENCE_WRITER.test(seg) || IN_PLACE.test(seg) || (INTERPRETER.test(seg) && WRITE_CALL.test(seg))) return GIT_CONFIG_WRITE;
  }
  return null;
}
// gh's own commands (gh help), its extension command's names and the built-in alias co
const GH_COMMANDS = new Set(['auth', 'browse', 'codespace', 'discussion', 'gist', 'issue', 'org', 'pr', 'project', 'release', 'repo',
  'skill', 'cache', 'run', 'workflow', 'co', 'agent-task', 'alias', 'api', 'attestation', 'completion', 'config', 'copilot',
  'extension', 'extensions', 'ext', 'gpg-key', 'label', 'licenses', 'preview', 'ruleset', 'search', 'secret', 'ssh-key', 'status',
  'variable', 'help', 'version', 'accessibility', 'actions', 'environment']);
const GH_SYNC_VALUE = /^(?:-b|--branch|-s|--source)$/;
// gh's words w, gh at i, its command at j: why a non-lead role may not run it, or null
function ghRuns(w, i, j) {
  const sub = w[j];
  if (sub === undefined) return null;
  const s = sub.toLowerCase();
  const at = pastOpts(w, j + 1, GH_OPT_ARG), next = w[at] ?? '';
  if (/^(?:extensions?|ext)$/.test(s) && /^(?:install|upgrade|exec)$/.test(next)) {
    return `gh extension ${next} runs code that is not gh's as a gh command, past the merge rule: an extension is Ahmed's to add (cb ask)`;
  }
  if (s === 'workflow' && next === 'run') return `gh workflow run starts a workflow, which can merge or deploy: ${LEAD_MERGES}`;
  const rest = stopArgs(w.slice(at + 1));
  if (s === 'repo' && next === 'sync' && pastOpts(rest, 0, GH_SYNC_VALUE) < rest.length) {
    return `gh repo sync <repo> moves a branch on GitHub: sync your local checkout with plain gh repo sync, and ${LEAD_MERGES}`;
  }
  if (isCommandWord(w, i) && !GH_COMMANDS.has(s)) {
    return `gh ${sub} is not a gh command (an extension or an alias runs its own code, past the merge rule): use gh's own commands; a new one is Ahmed's (cb ask)`;
  }
  return null;
}

// Secret files (#4347). What a seat reads goes to the model provider, and the board holds client work, so no role
// reads a secret file into its context: .env and its real variants (not .env.example/sample/template/dist, nor source
// files named after it: .env.d.ts, .env.md), private keys and keystores, .pgpass, .netrc, git, npm, cloud and container
// credentials, the seat's messaging token file. Using one where it lives (node --env-file=.env, docker compose
// --env-file) passes: no read word names it. Per segment (review M3): the reader and the name in the same command; an
// input redirect (< .env) is a read; the bootstrap copy of a template (cp .env.example .env) and --exclude=.env pass.
// Quote pairs inside a word (.e""nv) count. kit/permissions/<role>.json denies the same files to Read (a closed list:
// it can only name files). Linear: every name starts at a path boundary, so a long word is read once.
const SECRET_LEAD = String.raw`(?:^|[\s"'=:(\\/~@<,{;|&>$` + '`' + String.raw`])`;
const SECRET_END = String.raw`(?=[\s"';&|)<>*?[{},:` + '`' + String.raw`]|$)`;
const SOURCE_EXT = String.raw`(?:md|mdx|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|cs|txt|html|css)`;
const SECRET_NAME = new RegExp(SECRET_LEAD + String.raw`(?:\.env(?!\.(?:example|sample|template|dist)(?![\w.-]))(?![\w.-]*\.${SOURCE_EXT}(?![\w.-]))(?:\.[\w.-]*)?|[\w.-]+\.(?:pem|key|p12|pfx|jks|keystore|tfvars)|id_(?:rsa|ed25519|ecdsa|dsa)|\.pgpass|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.htpasswd|\.credentials\.json|\.aws[\\/]+credentials|\.kube[\\/]+config|\.docker[\\/]+config\.json|service-account[\w.-]*\.json|cb-seat-[\w.-]*\.(?:claude|opencode)\.json)` + SECRET_END, 'i');
const SECRET_READERS = ['cat', 'tac', 'type', 'get-content', 'gc', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'grep', 'egrep',
  'fgrep', 'rg', 'ag', 'ack', 'findstr', 'select-string', 'sls', 'awk', 'gawk', 'sed', 'cut', 'sort', 'uniq', 'paste', 'strings',
  'xxd', 'od', 'hexdump', 'base64', 'diff', 'cp', 'copy', 'copy-item', 'cpi', 'scp', 'rsync', 'curl', 'wget', 'nc', 'tar', 'zip',
  '7z', 'jq', 'yq', 'source', 'readallbytes', 'readalltext', 'readalllines', 'show', 'xargs', 'openssl', 'ssh-add', 'import-csv',
  'ipcsv', 'tee'];
// a reader word (not $type, not part of a path), a dot-source (. ./.env), or an input redirect (< .env, $(<.env))
const SECRET_READER = new RegExp(String.raw`(?<![\w.$\\/-])(?:${SECRET_READERS.join('|')})(?![\w.\\/-])|(?:^|[\s;&|(])\.(?=[ \t])|(?<![<\d])<(?![<(])`, 'i');
const TEMPLATE_COPY = /^\s*(?:cp|copy|copy-item|cpi)\s+(?:-\S+\s+)*["']?[^\s"']+\.(?:example|sample|template|dist)["']?\s+["']?[^\s"']+["']?\s*$/i;
const EXCLUDE = /--exclude(?:-dir)?=\S*/gi;
const dequote = (t) => t.replace(/""|''/g, '');
const SECRET = 'secret files (#4347): what a seat reads goes to the model provider, so no seat reads .env, a private key, .pgpass/.netrc, git, npm or cloud credentials or a seat token file. Use the file where it lives (node --env-file=.env, docker compose --env-file .env) and name where a value lives instead of printing it; .env.example shows the keys. A value you need: cb ask';
// a file path that is a secret file (for an adapter whose agent reads files natively, review I4)
export function secretPath(path) {
  return typeof path === 'string' && path !== '' && SECRET_NAME.test(` ${path}`);
}
// Stripping only removes text: a raw command naming no secret file cannot name one stripped (the cheap test first). A
// backtick substitution inside a message runs before the message goes anywhere (review I1), so with one the message
// text is judged too. #4589: the joined text is judged as well as the raw lines (rawAndJoined, as for the fence, #4587):
// cat \<newline>.env split the reader from the name, and .e\<newline>nv hid the name from the cheap test.
// (called through, not built here: rawAndJoined is defined further down)
function secretRead(raw) { return rawAndJoined(secretReadOne)(raw); }
function secretReadOne(command) {
  if (!SECRET_NAME.test(command) && !SECRET_NAME.test(dequote(command))) return null;
  const text = dequote(command.includes('`') ? command : stripMessages(command)).replace(EXCLUDE, ' ');
  for (const seg of text.match(SEGMENTS) ?? []) {
    if (TEMPLATE_COPY.test(seg)) continue;
    if (SECRET_NAME.test(seg) && SECRET_READER.test(seg)) return SECRET;
  }
  return null;
}

// The fence (#4345). A squad seat runs under bypassPermissions, so the guard's hook entry in ~/.claude/settings*.json
// (or a repo's .claude/settings*.json) and ~/.claude-board (the installed guard, the runner config) are all that stand
// between it and anything: no role writes them from a shell, and none runs the guard installer (it installs whatever
// guard its own checkout holds). Reading stays open. kit/permissions/<role>.json denies the same paths to Edit/Write
// (Claude seats); the other agents' shims pass their edit targets to evaluate, which applies editFence (#4002).
// A tripwire, not a sandbox: it reads command text, so a script the seat wrote and then runs (node fix.mjs) or a path
// built in a variable passes. It stops the accident and the injected command; the boundary is OS permissions.
// Per segment (review I3): a segment that names a fence path blocks when it also has a writer (git unless a known read
// subcommand, a formatter only with its write flag: #4002 review 68-I1), an in-place edit, an interpreter with a write
// call, or a redirect INTO a fence path; after a cd into ~/.claude or ~/.claude-board any later writer or redirect blocks.
// Fence paths: .claude/settings*.json anywhere, the .claude folder itself (moving or deleting it, a git write in it), and
// .claude-board; a repo's .claude/skills, agents, worktrees are ordinary work. Spellings that hide the path count: quote
// pairs and a backslash inside the word (.cla""ude, .cl\aude), a glob (.cl*, .claud?), trailing dots (.claude.), the 8.3
// name (CLAUDE~1), ./ and seg/../ (review 68-I2). A URL names no local file. Fail closed. Linear: a few single-pass
// tests per segment.
// PR 77 review I2: a backtick starts and ends a path too (echo `cp x ~/.claude/settings.json` hid it)
const TICK = '`';
const FENCE_LEAD = String.raw`(?:^|[\s"'=:(\\/~` + TICK + '])';
const FENCE_END = String.raw`(?=[\s"';&|)>` + TICK + ']|$)';
const FENCE_NAME = String.raw`(?:\.claude\.*|claude~\d)`;
const FENCE_PATH = new RegExp(FENCE_LEAD + String.raw`(?:\.claude-board\.*(?=[\\/\s"';&|)>` + TICK + String.raw`]|$)|${FENCE_NAME}(?:[\\/]+settings[\w.*?-]*\.json|[\\/]*)${FENCE_END}|\.c[\w.-]{0,64}[*?[][^\s/\;&|]{0,64}${FENCE_END}|\.c[\w.-]{0,64}[*?[][^\s/\;&|]{0,64}[\\/]+settings[\w.*?-]*\.json${FENCE_END})`, 'i');
// The other agents' own guard and config files (#4002 install gate): the hook file each adapter's guardInstallSpec names
// (~/.codex/hooks.json, a seat's .agents/hooks.json, OpenCode's plugins folder), Codex's config and profiles (hook trust,
// [features] hooks), every OpenCode config (opencode.json[c] anywhere: plugins, permissions, MCP) and all of ~/.gemini
// (agy's settings, trusted workspaces, global hooks and MCP), and the Codex and OpenCode config folders themselves (moving
// or deleting one, a cd into one). test/guard-fence-agents.test.ts pins it to the adapters.
// Review 68-I1: the repo-level names stay fenced anywhere (a repo's own .codex hooks run unreviewed under Codex's hook-trust
// bypass, .agents/hooks.json runs in a trusted agy folder, a repo's opencode.json or .opencode/plugins load into a seat),
// but ~/.gemini and ~/.config/opencode only under a home folder: a repo's .gemini/ (a styleguide) is not agy's config.
// Trailing dots (Windows drops them) and the 8.3 names (CODEX~1) count, as for .claude.
const AGENT_FENCE = new RegExp(FENCE_LEAD + String.raw`(?:(?:\.codex\.*|codex~\d)(?:[\\/]+(?:hooks\.json|[\w.-]*\.toml)\.*|[\\/]*)|\.agents\.*[\\/]+hooks\.json\.*|opencode\.jsonc?\.*|(?:\.opencode\.*|openco~\d)(?:[\\/]+plugins?\.*(?:[\\/]+[^\s"';&|)>]*)?|[\\/]*))` + FENCE_END, 'i');
// #4551 (review 68-m3): bash's $USERPROFILE (Git Bash has it) and PowerShell's ${env:USERPROFILE} too
const HOME = String.raw`(?:~|\$\{?(?:HOME|USERPROFILE)\}?|\$\{?env:(?:USERPROFILE|HOME)\}?|%USERPROFILE%|[\\/](?:Users|home)[\\/]+[^\\/\s"';&|)>]+|[\\/]root)[\\/]+`;
const HOME_AGENT_FENCE = new RegExp(HOME + String.raw`(?:(?:\.gemini\.*|gemini~\d)(?:[\\/]+[^\s"';&|)>]*)?|\.config\.*[\\/]+opencode\.*(?:[\\/]+plugins?\.*(?:[\\/]+[^\s"';&|)>]*)?|[\\/]*))` + FENCE_END, 'i');
// the cd argument is in the fence: anything under .claude-board, or the .claude folder itself
const IN_BOARD_DIR = /(?:^|[\\/~])\.claude-board\.*(?:[\\/]|$)/i;
const IS_CLAUDE_DIR = /(?:^|[\\/~])(?:\.claude\.*|claude~\d)[\\/]*$/i;
// or another agent's config folder: a .codex or .opencode folder, ~/.gemini, ~/.config/opencode
const IS_AGENT_DIR = /(?:^|[\\/~])(?:\.codex\.*|codex~\d|\.opencode\.*|openco~\d)(?:[\\/]|$)/i;
const IS_HOME_AGENT_DIR = new RegExp(HOME + String.raw`(?:\.gemini\.*|gemini~\d|\.config\.*[\\/]+opencode\.*)(?:[\\/]|$)`, 'i');
// #4590: the cd's redirects go first (cd ~/.claude 2>/dev/null still enters the fence)
// #4595: the whole argument and each word on its own: an option after the target (Set-Location $HOME\.claude -PassThru,
// sl ~/.claude -ea 0, cd ~/.claude --) hid it from the end-anchored tests. Any word, not the first non-option one: which
// options take a value is not known here (-ErrorAction 0 ~/.claude), so fail closed. -Path:<dir> names its value too.
const CD_WORD = /"[^"]*"|'[^']*'|\S+/g;
const isFenceDir = (a) => forms(a).some((f) => IN_BOARD_DIR.test(f) || IS_CLAUDE_DIR.test(f) || IS_AGENT_DIR.test(f) || IS_HOME_AGENT_DIR.test(f));
const fenceDir = (seg) => {
  const arg = seg.replace(CD, '').replace(REDIRECT_TARGET, ' ').trim();
  if (isFenceDir(arg.replace(/^["']|["']$/g, ''))) return true;
  return (arg.match(CD_WORD) ?? []).some((w) => isFenceDir(w.replace(/^-[\w-]+:/, '').replace(/^["']|["']$/g, '')));
};
// #4631: Push-Location is pushd's PowerShell name
const CD = /^\s*(?:cd|pushd|chdir|set-location|push-location|sl)\s+/i;
// a redirect whose target is a fence path, or (after a cd into one) any redirect but to the null device.
// #4631: any fd number (Git Bash opens and truncates the target of 10>)
const REDIRECT_TARGET = /(?<![-\d&])\d*>>?[ \t]*["']?(\S*)/g;
const NULL_DEVICE = /^(?:\/dev\/null|\$null|nul)(?![\w/.\\-])/i;
const FENCE_WORDS = ['tee', 'cp', 'mv', 'rm', 'rmdir', 'ln', 'install', 'rsync', 'dd', 'truncate', 'touch', 'chmod', 'chown',
  'curl', 'wget', 'sponge', 'patch', 'tar', 'unzip', '7z', 'set-content', 'sc', 'add-content', 'ac', 'out-file',
  'new-item', 'ni', 'remove-item', 'ri', 'del', 'erase', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move',
  'rename-item', 'rni', 'ren', 'clear-content', 'clc', 'mklink', 'robocopy', 'xcopy', 'icacls', 'takeown', 'attrib',
  'expand-archive', 'invoke-webrequest', 'iwr',
  // .NET from PowerShell ([IO.File]::WriteAllText(...)), and editors
  'writealltext', 'writeallbytes', 'writealllines', 'appendalltext', 'appendalllines',
  'vi', 'vim', 'nvim', 'nano', 'emacs', 'code', 'notepad'];
// a whole word (not part of a path or a longer word): touch in ~/.claude/touch is not the command
const FENCE_WRITER = new RegExp(String.raw`(?<![\w.\\/-])(?:${FENCE_WORDS.join('|')})(?![\w.\\/-])`, 'i');
// git is a reader only through a known read subcommand (review 68-I1: git diff, log, show, blame, grep and status naming a
// fence path were blocked), found after its global options (-C dir, -c k=v, --git-dir dir, quoted or not); anything else,
// an unknown or unreadable form included, or a read with --output, is a writer (fail closed). A formatter writes only
// with its write flag.
// #4551 (review 68-m1): git is judged as a command, not as a word anywhere (rg -n git opencode.json is rg's search text).
// - In command position every form above holds, a missing or shell-filled subcommand included. Command position: the
//   segment's first word past VAR=x assignments and !, if, then, else, do, while, time, or the first word after ( { $( or
//   a backtick; any spelling of git (/usr/bin/git, git.exe, a quoted path).
// - Anywhere else (sudo git, xargs git, timeout 5 git, find -exec git, pnpm exec git: no launcher list to fall behind) it
//   is a git call when the word past its options is a bare word (add, checkout) or one the shell fills in ($S), and then
//   the same rules hold. A path or file name there (rg -n git opencode.json, cb help git -- .codex) is text: a read.
// - A quoted word with a space or separator in it (bash -c "git add opencode.json") is judged as a command line too.
// Review 68-m2: a git call that runs a program is a writer: -c or --config-env setting an alias, include, external diff,
// textconv, filter, credential helper, pager (but cat, less, more), editor, fsmonitor, hooks path or ssh command;
// --exec-path=<dir>; grep -O (--open-files-in-pager); GIT_EXTERNAL_DIFF, GIT_CONFIG*, GIT_SSH*, GIT_EXEC_PATH,
// GIT_ASKPASS, GIT_EDITOR or a pager (but cat, less, more) assigned earlier in the segment.
const GIT_READS = new Set(['diff', 'log', 'show', 'blame', 'annotate', 'grep', 'status', 'ls-files', 'ls-tree', 'cat-file', 'rev-parse',
  'rev-list', 'describe', 'shortlog', 'whatchanged', 'diff-tree', 'diff-files', 'diff-index', 'show-ref', 'name-rev', 'help', 'version']);
// a segment's words, quote-aware (an unclosed quote runs to the end), with ( ) { } and a backtick as words of their own
const GIT_TOKEN = /(?:"(?:\\.|[^"\\])*"?|'[^']*'?|\\.|[^\s(){}`"'\\])+|[(){}`]/g;
const GIT_OPENER = /^[(){}`]$/;
const SHELL_KEYWORD = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time']);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const PAGER_OK = /^\s*(?:(?:cat|less|more)(?:\s+-\w+)*)?\s*$/i;
const GIT_RUNS_ENV = /^(?:GIT_EXTERNAL_DIFF|GIT_CONFIG\w*|GIT_SSH\w*|GIT_EXEC_PATH|GIT_ASKPASS|GIT_EDITOR|(?:GIT_)?PAGER)=/i;
const GIT_RUNS_KEY = /^(?:alias|include|includeif|pager)\.|^(?:core\.(?:fsmonitor|hookspath|sshcommand|askpass|gitproxy|editor)|sequence\.editor)$|\.(?:external|textconv|command|cmd|program|helper|clean|smudge|process|proxycommand)$/i;
const BARE = /^[a-z][\w-]*$/i;
// git's words (w[0] is git): true when the call writes or runs a program. atCommand: git is in command position;
// runsEnv: the segment set a program-running git variable before it
function gitCallWrites(w, atCommand, runsEnv) {
  let i = 1;
  for (; i < w.length && w[i].startsWith('-'); i++) {
    const o = w[i];
    if (/^--exec-path=/i.test(o)) return true;
    const isEnv = /^--config-env(?:=|$)/.test(o);
    const cfg = o === '-c' || o === '--config-env' ? (w[++i] ?? '') : isEnv ? o.slice(13) : null;
    if (cfg === null) { if (GIT_OPT_ARG.has(o)) i++; continue; }
    const eq = cfg.indexOf('='), key = eq < 0 ? cfg : cfg.slice(0, eq);
    if (GIT_RUNS_KEY.test(key)) return true;
    if (/^core\.pager$/i.test(key) && (isEnv || !PAGER_OK.test(eq < 0 ? '' : cfg.slice(eq + 1)))) return true;
  }
  const sub = w[i] ?? '';
  if (!atCommand && !BARE.test(sub) && !/[$%`]/.test(sub)) return false; // text, not a git call
  const s = sub.toLowerCase();
  if (runsEnv || !GIT_READS.has(s) || w.some((x) => /^--output(?:=|$)/.test(x))) return true;
  return s === 'grep' && w.slice(i + 1).some((x) => /^--op/.test(x) || /^-(?!-)[A-Za-z]*O/.test(x));
}
// PR 77 review I1: a command word the shell fills in ($GIT, "$GIT", ${GIT:-git}, $(...), a backtick) is an unknown
// program, judged as git (fail closed: $GIT checkout -- opencode.json blocks, $GIT log -- opencode.json reads). So is an
// expansion after one of these launchers (sudo $GIT checkout ...), with the argument-position rule. A PowerShell
// assignment ($x = ...) is not a command word.
const LAUNCHERS = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'timeout', 'gtimeout', 'time', 'stdbuf',
  'ionice', 'watch', 'parallel', 'strace', 'ltrace', 'xargs', 'npx', 'pnpx', 'bunx', 'pnpm', 'npm', 'yarn', 'bun', 'ssh', 'eval', 'coproc',
  'chronic', 'unbuffer', 'flock', 'setsid', 'script', 'runas', 'start', 'start-process', 'find', 'fd', 'busybox', 'wsl', 'winpty']);
const PS_ASSIGN = /^\$[\w:.{}]+(?:[+\-*/]?=.*)?$/;
// Every git command name, read or write (PR 77 round 3: a list of only the writing ones missed merge-file, stage and a
// read's --output). A shell-filled word, in ANY position, whose next word that is not an option is one of these, or is
// filled in itself ($SUB, a backtick), is git, judged with the command-position rule: an unknown subcommand writes, a read
// is still checked for --output. Anything else after it is not git ($PAGER opencode.json, echo $HOME opencode.json).
const GIT_COMMANDS = new Set([...GIT_READS, 'add', 'am', 'apply', 'archive', 'bisect', 'branch', 'bugreport', 'bundle', 'check-attr',
  'check-ignore', 'check-mailmap', 'check-ref-format', 'checkout', 'checkout-index', 'cherry', 'cherry-pick', 'citool', 'clean', 'clone',
  'column', 'commit', 'commit-graph', 'commit-tree', 'config', 'count-objects', 'credential', 'daemon', 'diagnose', 'difftool',
  'fast-export', 'fast-import', 'fetch', 'fetch-pack', 'filter-branch', 'fmt-merge-msg', 'for-each-ref', 'for-each-repo', 'format-patch',
  'fsck', 'gc', 'get-tar-commit-id', 'gui', 'hash-object', 'hook', 'http-backend', 'index-pack', 'init', 'instaweb', 'interpret-trailers',
  'lfs', 'ls-remote', 'mailinfo', 'mailsplit', 'maintenance', 'merge', 'merge-base', 'merge-file', 'merge-index', 'merge-one-file',
  'merge-tree', 'mergetool', 'mktag', 'mktree', 'multi-pack-index', 'mv', 'notes', 'pack-objects', 'pack-redundant', 'pack-refs',
  'patch-id', 'prune', 'prune-packed', 'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'receive-pack', 'reflog', 'refs', 'remote',
  'repack', 'replace', 'replay', 'request-pull', 'rerere', 'reset', 'restore', 'revert', 'rm', 'send-email', 'send-pack', 'show-branch',
  'show-index', 'sparse-checkout', 'stage', 'stash', 'stripspace', 'submodule', 'svn', 'switch', 'symbolic-ref', 'tag', 'unpack-file',
  'unpack-objects', 'update-index', 'update-ref', 'update-server-info', 'upload-archive', 'upload-pack', 'var', 'verify-commit',
  'verify-pack', 'verify-tag', 'worktree', 'write-tree', 'backfill', 'checkout--worker', 'credential-cache',
  'credential-cache--daemon', 'credential-store', 'credential-wincred', 'diff-pairs', 'difftool--helper', 'fsck-objects', 'fsmonitor--daemon',
  'http-fetch', 'http-push', 'imap-send', 'init-db', 'last-modified', 'merge-octopus', 'merge-ours', 'merge-recursive', 'merge-recursive-ours',
  'merge-recursive-theirs', 'merge-resolve', 'merge-subtree', 'pickaxe', 'quiltimport', 'remote-ext', 'remote-fd', 'remote-ftp', 'remote-ftps',
  'remote-http', 'remote-https', 'repo', 'submodule--helper', 'subtree', 'survey', 'update', 'upload-archive--writer', 'web--browse']);
// the index just past the filled word at raw[k]: past a whole ${...}, $(...) or backtick group
const SHAPES = new WeakMap();
function shape(raw) {
  let r = SHAPES.get(raw);
  if (r) return r;
  const ends = new Int32Array(raw.length).fill(raw.length), closingTick = new Uint8Array(raw.length), nextTick = new Int32Array(raw.length + 1).fill(-1);
  const st = { '(': [], '{': [] };
  let ticks = 0;
  for (let j = 0; j < raw.length; j++) {
    const x = raw[j];
    if (x === '(' || x === '{') st[x].push(j);
    else if (x === ')' || x === '}') { const o = st[x === ')' ? '(' : '{'].pop(); if (o !== undefined) ends[o] = j + 1; }
    else if (x === '`') closingTick[j] = ticks++ % 2;
  }
  for (let j = raw.length - 1, n = -1; j >= 0; j--) { nextTick[j] = n; if (raw[j] === '`') n = j; }
  r = { ends, closingTick, nextTick };
  SHAPES.set(raw, r);
  return r;
}
function filledEnd(raw, k) {
  const open = raw[k] === '`' ? '`' : raw[k] === '$' && /^[({]$/.test(raw[k + 1] ?? '') ? raw[k + 1] : null;
  if (!open) return k + 1;
  const { ends, nextTick } = shape(raw);
  if (open === '`') { const j = nextTick[k]; return j < 0 ? raw.length : j + 1; }
  return ends[k + 1];
}
// a word the shell fills in: $X, ${...}, $(...), or cmd's %X% (round 4, I2)
const isFilled = (u) => u.startsWith('$') || /^%[A-Za-z_]\w*%/.test(u);
// git's own options a filled word may carry before its subcommand: more than this many and the word is judged a writer
const MAX_FILLED_OPTS = 32;
const GIT_GLOBAL_OPTS = new Set(['-v', '--version', '-h', '--help', '-C', '-c', '--exec-path', '--html-path', '--man-path', '--info-path',
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--bare',
  '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--list-cmds', '--super-prefix', '--shallow-file', '--']);
// programs that neither run nor print their arguments (not echo/printf: what they print may be run); git in command
// position is judged whole by the command-position rule, so its later words are arguments too
const NO_RUN = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'cmp', 'diff', 'stat', 'sha256sum', 'md5sum',
  'get-content', 'gc', 'select-string', 'sls', 'test-path', 'get-item', 'gi']);
// a filled word at raw[k] (any position): true when it is a git call that writes. Its options are judged as git's, not
// skipped (round 4, I2: -c alias.x=checkout, --config-env, --exec-path=, --attr-source <v>). The subcommand slot holds a
// git command, a bare $VAR / ${VAR} / %VAR%, or a ${...} / $(...) / backtick group; a path ($HOME/.codex/...) is not one
// (round 4, I1). judge(words, atCommand) is the segment's budgeted gitCallWrites (round 4, I5).
function filledWrites(raw, k, judge) {
  const after = filledEnd(raw, k);
  for (let j = after, opts = 0; j < raw.length; j++) {
    const x = raw[j];
    if (x === ')' || (x === '`' && shape(raw).closingTick[j])) return false; // the filled word's command ended
    if (/^[({}]$/.test(x)) continue;
    const v = unquote(x);
    if (x !== '`' && v.startsWith('-')) {
      if (++opts > MAX_FILLED_OPTS) return true;
      if (!GIT_GLOBAL_OPTS.has(v.split('=')[0]) && !/^-C./.test(v)) return false;
      const opt = v === '-c' || v === '--config-env' || GIT_OPT_ARG.has(v) ? [v, unquote(raw[j + 1] ?? '')] : [v];
      if (gitCallWrites(['git', ...opt, 'status'], true, false)) return true;
      if (GIT_OPT_ARG.has(v)) j++;
      continue;
    }
    const filledSub = x === '`' || (x === '$' && /^[({]$/.test(raw[j + 1] ?? '')) || /^(?:\$\{?[A-Za-z_]\w*\}?|%[A-Za-z_]\w*%)$/.test(v) || (/\$|%[A-Za-z_]\w*%/.test(v) && !/[\\/]/.test(v));
    if (!filledSub && !GIT_COMMANDS.has(v.toLowerCase())) return false;
    return judge(() => ['git', ...raw.slice(after).filter((y) => !GIT_OPENER.test(y)).map(unquote)], true);
  }
  return false;
}
const gitWrites = (seg, inQuote = false) => {
  const raw = seg.match(GIT_TOKEN) ?? [];
  let start = true, runsEnv = false, launched = false, noRun = false, afterClose = false, ticks = 0;
  const rest = (k) => raw.slice(k).filter((x) => !GIT_OPENER.test(x)).map(unquote);
  // round 4, I5: each git call reads the rest of the segment, so a segment judges at most MAX_COMMANDS_PER_SEGMENT of them
  // and blocks past that (a scan that runs past the hook's timeout lets the command through), as scanCommands does
  let budget = MAX_COMMANDS_PER_SEGMENT;
  const judge = (words, atCommand) => (--budget < 0 ? true : gitCallWrites(words(), atCommand, runsEnv));
  for (let k = 0; k < raw.length; k++) {
    const t = raw[k];
    if (GIT_OPENER.test(t)) {
      // a backtick in command position runs what it prints: an unknown program whose first word is the subcommand slot
      if (t === '`' && start && !inQuote && judge(() => ['`', ...rest(k + 1)], true)) return true;
      if (t === '`' && ticks++ % 2 === 0 && filledWrites(raw, k, judge)) return true; // anywhere: caffeinate `which git` checkout
      start = true;
      noRun = false;
      afterClose = t === ')' || t === '}' || (t === '`' && ticks % 2 === 0);
      continue;
    }
    const u = unquote(t);
    if (start && PS_ASSIGN.test(u) && (/=/.test(u) || /^[+\-*/]?=/.test(raw[k + 1] ?? ''))) { // $x = ..., $env:X='y'
      if (!/=/.test(u)) k++;
      continue;
    }
    // a quoted command line, judged on its own: one layer of quotes off (an unclosed quote dropped, so it always shrinks)
    if (/["']/.test(t) && /[\s;&|]/.test(u)) {
      const inner = u === t ? t.replace(/["']/g, '') : u;
      if (inner.length < t.length && (inner.match(SEGMENTS) ?? []).some((x) => gitWrites(x, true))) return true;
    }
    if (ASSIGNMENT.test(u)) { // VAR=x git ..., env VAR=x git ...
      const eq = u.indexOf('=');
      if (GIT_RUNS_ENV.test(u) && !(/pager$/i.test(u.slice(0, eq)) && PAGER_OK.test(u.slice(eq + 1)))) runsEnv = true;
      if (start) continue;
    }
    const filled = isFilled(u) && (start || launched);
    // a filled word takes the argument-position rule ($PAGER opencode.json is no git call; $GIT $SUB still blocks)
    const isGit = cmdName(t) === 'git';
    // a $( or ${ group in command position: the subcommand slot is the word after the whole group (round 4, I4); inside
    // a quoted line ("$(git rev-parse --show-toplevel)/x", "$USER reading x") a filled first word takes the filledWrites test
    const words = () => (u === '$' && /^[({]$/.test(raw[k + 1] ?? '') ? ['$', ...rest(filledEnd(raw, k))] : rest(k));
    if (filled && start && inQuote) { if (filledWrites(raw, k, judge)) return true; }
    else if ((isGit || filled) && judge(words, start && isGit)) return true;
    // a shell-filled word in ANY position (caffeinate $GIT, arch -arm64 $GIT, time -p $GIT, . $GIT: no wrapper list to fall
    // behind), judged by the word after it (GIT_COMMANDS)
    if (isFilled(u) && !noRun && filledWrites(raw, k, judge)) return true;
    if (start && !SHELL_KEYWORD.has(u.toLowerCase())) {
      start = false;
      if (LAUNCHERS.has(cmdName(t))) launched = true;
      // only a real command word: not one after a closing ) } or backtick (caffeinate $(echo --name) cat $GIT ...)
      noRun = !launched && !afterClose && (isGit || NO_RUN.has(cmdName(t).toLowerCase()));
    }
  }
  return false;
};
const FORMAT_WRITE = /(?<![\w.\\/-])(?:prettier|eslint|biome|dprint|oxlint)(?![\w.\\/-])[^;&|]*[ \t](?:--write|-w|--fix|--apply)(?![\w-])/i;
const writes = (seg) => FENCE_WRITER.test(seg) || gitWrites(seg) || FORMAT_WRITE.test(seg) || IN_PLACE.test(seg) || (INTERPRETER.test(seg) && WRITE_CALL.test(seg));
// an interpreter writes only when its code says so (review I3: node x.mjs ~/.claude/settings.json is a read)
const INTERPRETER = /(?<![\w.\\/-])(?:python3?|py|node|deno|bun|ruby|perl|awk|gawk|sh|bash|zsh|pwsh|powershell)(?![\w.\\/-])/i;
const WRITE_CALL = /write|append|unlink|rename|copy|move|remove|delete|rmdir|rmsync|truncate|chmod|replace|dump|mkdir|\bopen\s*\([^),]{0,300},\s*["'][wax+]|-i\b|--in-place/i;
const IN_PLACE = thenLater(SEGMENTS, String.raw`(?<![\w.-])(?:sed|perl)(?![\w.-])`, String.raw`[ \t](?:-[a-z]*i|--in-place)`);
// the guard's installer, not any project's install.mjs: the file named under a guard folder, or run from inside one
const INSTALLER = /(?:^|[\s"'\\/])install\.mjs(?![\w.-])/i;
const GUARD_DIR = /(?:^|[\s"'\\/])guard(?=[\\/\s"';&|)]|$)/i;
const GUARD_INSTALL = { test: (s) => INSTALLER.test(s) && GUARD_DIR.test(s) };
const FENCE = 'the fence (#4345): the hook settings (.claude/settings*.json), the .claude folder itself, ~/.claude-board (the guard, the runner config) and the other agents\' hook and config files (~/.codex hooks.json and *.toml, .agents/hooks.json, ~/.gemini, opencode.json, OpenCode plugins) are Ahmed\'s; a squad seat never writes them or runs the guard installer. Reading them is fine. A change there is his: cb ask';
// a hidden spelling as plain text: quote pairs and a backslash between letters go (only ever an extra test: the
// original is tested too, so a Windows path keeps its separators)
const unhide = (t) => t.replace(/""|''/g, '').replace(/(?<=[a-z])\\(?=[a-z])/gi, '');
// review 68-I2: /./ and seg/../ folded, so ~/.codex/./hooks.json and ~/.codex/x/../hooks.json name the file they reach
// (bounded: a few passes, each linear)
// #4551 (review 68-m3): a segment of three or more dots goes too (Windows drops a segment's trailing dots, so
// ~/.codex/.../hooks.json is ~/.codex/hooks.json there)
const fold = (t) => {
  let s = t.replace(/(?<=[\\/])\.{3,}(?:[\\/]+|(?=[\s"';&|)>]|$))/g, '').replace(/(?<=[\\/])(?:\.[\\/]+)+/g, '');
  for (let i = 0; i < 8; i++) {
    const n = s.replace(/(?<![^\\/\s"'=:(>])(?!\.\.?(?:[\\/]|$))[^\\/\s"';&|)>]+[\\/]+\.\.(?:[\\/]+|(?=[\s"';&|)>]|$))/g, '');
    if (n === s) break;
    s = n;
  }
  return s;
};
// #4551 (review 68-m3): an NTFS stream suffix names the file or folder itself (hooks.json::$DATA is hooks.json's main
// stream, .codex::$INDEX_ALLOCATION or .codex:$I30:$INDEX_ALLOCATION the folder), and a shell that expands $DATA to
// nothing leaves hooks.json:: behind
const noStream = (t) => t.replace(/:(?:\$I30)?:(?:\$(?:DATA|INDEX_ALLOCATION))?(?=[\\/\s"';&|)>]|$)/gi, '');
const forms = (t) => { const u = unhide(t), n = noStream(t); return [t, u, fold(t), fold(u), n, fold(n), noStream(fold(u))]; };
const fencePath = (t) => forms(t).some((f) => FENCE_PATH.test(f) || AGENT_FENCE.test(f) || HOME_AGENT_FENCE.test(f));
function redirects(seg, anyTarget) {
  for (const m of seg.matchAll(REDIRECT_TARGET)) {
    const target = m[1] ?? '';
    if (!target || target.startsWith('&') || NULL_DEVICE.test(target)) continue;
    if (anyTarget || fencePath(` ${target}`)) return true;
  }
  return false;
}
// Stripping only removes text, so a raw command naming neither a fence path nor the installer cannot name one stripped:
// skip the second stripMessages (the costly step on big heredocs) for nearly every command.
const RAW_HINT = /\.c[\w.\\"'*?[-]*|claude~\d|codex~\d|openco~\d|\.agents|gemini|opencode/i;
// a URL names a remote file, never a local one (review 68-I1: curl https://x/.agents/hooks.json -o /tmp/h.json is a read)
// (a scheme of two or more letters: C://Users/... is a drive, not a URL)
const URL_WORD = /(?<![\w+.-])[a-z][a-z\d+.-]+:\/\/[^\s"';&|)>]*/gi;
// a definition in command position: name() {, function name, alias [--] name=, hash -p, PowerShell Set-Alias / New-Alias / sal / nal
const DEFINES_FN = /(?:^|[;&|\n({])\s*(?:[\w.:-]+\s*\(\s*\)\s*[{(\n]|function\s+[\w.:-]+|alias\s+(?:-\S*\s+)*[\w.-]+=|hash\s+-p\s|(?:set-alias|new-alias|sal|nal)\s)/i;
// judged with quoted text blanked (round 2: grep -E "a|function b" opencode.json is a search, not a definition)
const QUOTED_TEXT = /"(?:\\.|[^"\\])*"|'[^']*'/g;
// #4587: a line continuation, joined as the shell joins it, before anything reads the command (the prefilter too: a
// split open\<newline>code.json names no fence word). bash drops a backslash-newline with nothing between, so
// .cla\<newline>ude is .claude: SHELL_ESCAPES's space would leave that split. Only an odd run of backslashes continues
// (\\<newline> is a backslash, then a real line end), read from the run's first backslash, so the pass stays linear.
// PowerShell's ` continuation reads as a space, as in SHELL_ESCAPES.
// PR 83 review I1: the joined text is judged as well as the raw lines, never instead of them. Which shell runs the
// command is not known here, and a trailing \ is not always a continuation: in PowerShell it ends a path (Set-Location
// C:\tmp\<newline>Copy-Item ...), and in a bash comment the newline still ends the line (ls # x\<newline>cp ...). Each
// reading blocks on its own; the joined one runs only when joining changed something, so the cost is at most two passes.
const joinLines = (t) => t.replace(/(?<!\\)((?:\\\\)*)\\\r?\n/g, '$1').replace(/`\r?\n/g, ' ');
const rawAndJoined = (check) => (raw) => {
  const joined = joinLines(raw);
  return check(raw) ?? (joined === raw ? null : check(joined));
};
// #4594: >| (n>| too) is bash's noclobber override, a redirect: read as > before the split, or its | cut the target off
// into a segment of its own. #4631: zsh's clobber forms too (Mac seat panes run zsh): >!, >>|, >>!, &>|, &>!, >&|,
// &>>|, each read as the redirect without its | or !. In bash &>| and >>| are syntax errors and >! writes a file named
// !, so nothing bash runs is read as a write it is not. Rewriting only merges, never hides.
const NOCLOBBER = /(&?>>?&?)[|!]/g;
// #4631: >&word sends both streams to the file word, unless word is an fd number or - (>&1, >&-: a duplication). Read
// as > before the split, or its & cut the target off into a segment of its own
const BOTH_TO = />&(?![ \t]*[\d-])/g;
const fenceWrite = rawAndJoined(fenceWriteOne);
function fenceWriteOne(command) {
  if (!RAW_HINT.test(command) && !GUARD_INSTALL.test(command)) return null;
  const text = stripMessages(command).replace(URL_WORD, ' ').replace(NOCLOBBER, '$1 ').replace(BOTH_TO, '> ');
  if (GUARD_INSTALL.test(text) && !(text.match(SEGMENTS) ?? []).every((s) => !INSTALLER.test(s) || /(?:^|[ \t])--check(?![\w-])/.test(s))) return FENCE;
  if (!fencePath(text)) return null;
  // PR 77 review M1: a function or alias defined on the same line moves the writer into another segment (f() { cp x "$1";
  // }; f .claude/settings.json; alias c=cp; c x opencode.json), so a line that names a fence path and defines one writes
  if (DEFINES_FN.test(text.replace(QUOTED_TEXT, '""'))) return FENCE;
  let inFence = false;
  for (const seg of text.match(SEGMENTS) ?? []) {
    // #4590: a cd's own redirect is opened by the shell before cd runs, so it is judged by its own target, never skipped
    if (CD.test(seg)) {
      if (redirects(seg, false)) return FENCE;
      inFence = fenceDir(seg);
      continue;
    }
    const names = fencePath(seg);
    if (!names && !inFence) continue;
    if (redirects(seg, inFence && !names)) return FENCE;
    if (writes(seg)) return FENCE;
  }
  return null;
}

// An edit tool's target paths (#4002 install gate): for an adapter whose agent edits files natively (Codex apply_patch,
// OpenCode edit/write/patch), so the fence and the secret rule reach edits, not only shell commands. Read from the path
// keys the CLIs use and from patch headers (*** Add/Update/Delete File:, *** Move to:) in any string of the input,
// recursively (Codex sends apply_patch as {command: "<patch>"} or {command: ["apply_patch", "<patch>"]}). [] when none:
// evaluate then blocks the edit, never allows an edit whose target it cannot see.
const PATH_KEYS = new Set(['file_path', 'filepath', 'path', 'targetfile', 'absolutepath', 'notebook_path', 'move_path']);
// leading whitespace allowed (review 68-M1): an indented header is still read, never skipped
const PATCH_FILE = /^[ \t]*\*\*\*[ \t]*(?:Add File|Update File|Delete File|Move to)[ \t]*:[ \t]*(.+?)[ \t]*$/gim;
export function editTargets(input) {
  const out = new Set();
  const walk = (v, key, depth) => {
    if (depth > 6) return;
    if (typeof v === 'string') {
      if (key !== null && PATH_KEYS.has(key.toLowerCase()) && v.trim()) out.add(v.trim());
      for (const m of v.matchAll(PATCH_FILE)) out.add(m[1]);
    } else if (Array.isArray(v)) for (const x of v) walk(x, null, depth + 1);
    else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(input, null, 0);
  return [...out];
}
// null, or why an edit tool may not write this path: a fence path (the hook settings, ~/.claude-board, another agent's
// hook or config file) or a secret file.
// Review 68-I2: every spelling of the path is judged, folded (/./, seg/../) and with each segment's trailing dots and
// spaces dropped (Windows drops them: .codex.\hooks.json is .codex\hooks.json). The shims add the resolved and real forms
// (editPathForms), since core has no fs.
const trimSegments = (p) => p.split(/([\\/]+)/).map((s, i) => (i % 2 || /^\.\.?$/.test(s) ? s : s.replace(/[. ]+$/, '') || s)).join('');
export function editFence(path) {
  if (typeof path !== 'string' || !path.trim()) return 'the edit names an empty target path';
  for (const p of new Set([path, trimSegments(path), fold(trimSegments(path))])) {
    if (fencePath(` ${p}`)) return FENCE;
    if (secretPath(p)) return SECRET;
  }
  return null;
}
/** The forms of an edit target a shim passes to evaluate (review 68-I2): as given, resolved against the cwd (folds ./ and
 *  ../ in absolute paths too), and through the real path of its nearest existing folder or itself, so a link is judged at
 *  its target. fs is the shim's { resolve, dirname, basename, join, realpathSync }: core stays import-free. */
export function editPathForms(path, cwd, fs) {
  const out = new Set([path]);
  let abs = null;
  try { abs = fs.resolve(cwd || '.', trimSegments(path)); } catch { /* the given form stays */ }
  if (abs) {
    out.add(abs);
    const rest = [];
    for (let dir = abs, i = 0; i < 64; i++) {
      try { out.add(fs.join(fs.realpathSync(dir), ...rest)); break; } catch { /* not there yet: one folder up */ }
      const up = fs.dirname(dir);
      if (up === dir) break;
      rest.unshift(fs.basename(dir));
      dir = up;
    }
  }
  return [...out];
}

// #4575: cb squad trust writes the agents' own config files (the fence's ~/.claude.json, ~/.codex/config.toml and agy
// settings) to mark folders trusted: Ahmed's one step, never a seat's, for every role including the lead. Read where a
// shell runs it (runnerArg), so a message or a grep that names it is text. Kept apart from the fence on purpose.
const CB_NAMES = new Set(['cb', 'cb.cmd', 'cb.ps1', 'cb.ts', 'cb.mjs', 'cb.js']);
const SQUAD_TRUST = 'cb squad trust writes the agents\' own config files to mark folders trusted (#4575): Ahmed runs it once in his own terminal, never a squad seat. A folder that needs it: cb ask';
// Fail closed (review 89 M1): cb takes its options anywhere (cb squad --machine pc trust x, cb --tag squad squad trust x),
// so any cb command holding both words is blocked, in any case. A PowerShell backtick escape inside a word (squa`d) is
// dropped first, as pwsh does.
function squadTrustRun(command) {
  return scanCommands(String(command ?? '').replace(/`(?=\w)/g, ''), CB_NAMES, (w, i) => {
    let squad = false, trust = false;
    for (let j = i + 1; j < w.length; j++) { const x = w[j].toLowerCase(); squad ||= x === 'squad'; trust ||= x === 'trust'; }
    return squad && trust ? SQUAD_TRUST : null;
  }, runnerArg);
}

// The reason a role may not run this shell command, or null. An unset or empty role: no role rules (a hand-started
// session); a role outside ROLES: blocked (evaluate checks that first). A quoted string is a command here only where a
// shell runs it (runnerArg), except for main/master: like the protected-branch scan, they read every quoted string, so
// a mention of pushing main (grep -rn "git push origin main" docs) blocks too.
export function checkRole(command, role) {
  if (!role) return null;
  if (!ROLES.includes(role)) return `unknown CB_ROLE "${role}"`;
  const secret = secretRead(String(command ?? ''));
  if (secret) return secret;
  const fence = fenceWrite(String(command ?? ''));
  if (fence) return fence;
  const gitConfig = gitConfigFileWrite(String(command ?? '')); // #4661 S1
  if (gitConfig) return gitConfig;
  const trust = squadTrustRun(command);
  if (trust) return trust;
  const readOnly = READ_ONLY_ROLES.includes(role);
  const git = scanCommands(unbrace(command), GIT, (w, i) => {
    const j = gitSub(w, i);
    const hides = gitHides(w, i, j, role); // #4638: aliases, push and commit plumbing, a read-only role's git ci
    if (hides) return hides;
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
  // #4638: a brace group with no space in it outside quotes (gh's {owner}, {repo}, {branch}; ${OWNER}, ${env:X}) read
  // without its braces, or the braces end the segment and hide the rest of a gh api call (gh api
  // repos/{owner}/{repo}/pulls/5/merge -X PUT)
  const gh = scanCommands(unbrace(command), GH, (w, i) => {
    let j = pastOpts(w, i + 1, GH_OPT_ARG);
    const runs = ghRuns(w, i, j); // #4661 L2
    if (runs) return runs;
    if (w[j] === 'api') return ghApiWrites(w, j) ? GH_WRITES : null; // #4638
    if (w[j] === 'alias' && /^(?:set|import)$/.test(w[pastOpts(w, j + 1, GH_OPT_ARG)] ?? '')) return `gh alias ${w[pastOpts(w, j + 1, GH_OPT_ARG)]} renames a gh command past the merge rule: ${LEAD_MERGES}`;
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
Ask on Agents Board instead, then KEEP WORKING on something else:

  cb ask <project> "<question>" -o "<Label>=<why / tradeoff>" -o "<Label (Recommended)>=<why>" [-c "<context, markdown>"] [--multi]

- Give the same options and explanations you would have put in the ask tool. Options are required;
  --free (no options) only for a fact: a URL, a name, a number.
- Add --blocking -t <task id> only if that task truly cannot continue; it parks the task in Blocked.
- The answer arrives in this session by itself (cb relay); without a relay, check with \`cb pending\`. More: cb help ask`;

// One decision for one tool call. req: { tool: 'shell' | 'edit' | 'ask' | 'unknown'; command?; role?; protectedBranches?;
// allowAsk?; agent? (CB_AGENT); paths? (an edit's targets, editTargets) }. Returns { allow: true } or { allow: false, kind, reason }: kind 'dangerous' (a dangerous command or a
// CB_PROTECTED_BRANCHES push), 'role' (a role rule), 'input' (unreadable input, unknown tool or role) or 'ask'. The
// shim words the reason for its CLI. It fails closed: anything it cannot read or decide blocks.
export function evaluate(req) {
  const block = (kind, reason) => ({ allow: false, kind, reason });
  try {
    const { tool, command, role = null, protectedBranches = [], allowAsk = false, agent = null, paths } = req ?? {};
    if (role !== null && role !== undefined && role !== '' && !ROLES.includes(role)) {
      return block('input', `unknown CB_ROLE ${JSON.stringify(role)}: a squad seat's role is one of ${ROLES.join(', ')}`);
    }
    // #4002 install gate: a pane with CB_AGENT is a board seat (cb squad up sets CB_AGENT and CB_ROLE together), so no
    // role there means a broken launch, never a hand-started session: block rather than skip every role rule.
    if (!role && typeof agent === 'string' && agent.trim()) {
      return block('input', `CB_ROLE is not set in this board seat (CB_AGENT=${JSON.stringify(agent.trim()).slice(0, 40)} is), so no role rule could apply: start the session with cb squad up, which sets both`);
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
    if (tool === 'edit') {
      if (READ_ONLY_ROLES.includes(role)) return block('role', `editing files: ${readsOnly(role)}`);
      // A shim that passes paths (an adapter's native edit tool, #4002) gets the fence and the secret rule on each, as a
      // shell command does; no target it could read blocks. Like the shell fence, only for a role seat.
      if (role && paths !== undefined) {
        if (!Array.isArray(paths) || paths.length === 0) return block('input', 'guard could not read the edit\'s target path: an edit whose target the guard cannot see is blocked');
        for (const p of paths) {
          const why = editFence(p);
          if (why) return block('role', why);
        }
      }
      return { allow: true };
    }
    // an adapter's native read tool (OpenCode read, grep, glob, list): no secret file into the context (#4347), like a
    // shell read; reading is otherwise open to every role
    if (tool === 'read') {
      if (role && Array.isArray(paths) && paths.some((p) => secretPath(p))) return block('role', SECRET);
      return { allow: true };
    }
    if (tool === 'ask') return allowAsk === true ? { allow: true } : block('ask', ASK);
    return block('input', `unrecognized tool (${JSON.stringify(tool) ?? 'none'})`);
  } catch (e) {
    return block('input', `guard error (${String(e?.message ?? e).slice(0, 200)})`);
  }
}
