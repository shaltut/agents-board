// Claude Code SessionStart hook: one line that points a new session at the board.
// Separate from the relay hook (cli/relay.ts), so changing this never restarts live relays.
// Only herdr panes get it: board sessions always run in one.
// #4351: after a compaction, a resume or a fork, a bound pane also gets what cb resume and cb role <its role> print, so the
// session does not have to remember to run them. In-process, never `cb` as a child: no process outlives the hook or
// holds Claude's pipe (#4482), and an unreachable board costs at most BUDGET_MS, then the hook prints the hint alone.
import { homedir } from 'node:os';
import { join } from 'node:path';

const BUDGET_MS = 2000; // everything after node's own start: stdin, the board, the write
const ROLES = ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator']; // cb.role_text's list
const CAP = 6000; // the re-injected block; the hint and the guard line always print whole
const started = Date.now();
const left = () => Math.max(0, BUDGET_MS - (Date.now() - started));

/** The hook's stdin (Claude sends one JSON object and closes it); what came by `ms`, '' on a TTY or an error. */
function readStdin(ms) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let s = '';
    // the error listener stays: a stdin error after this read must not throw (stderr, exit 1) while the board answers
    const done = () => { clearTimeout(t); process.stdin.off('data', data).off('end', done); process.stdin.pause(); resolve(s); };
    // done at the first whole object: a start never waits on a stdin that stays open
    const data = (d) => { s += d; try { JSON.parse(s); done(); } catch { if (s.length > 100_000) done(); } };
    const t = setTimeout(done, ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data).on('end', done).on('error', done);
  });
}

const cut = (s, n, cmd) => s.length <= n ? s : `${s.slice(0, Math.max(0, n - 40)).trimEnd()}\n[cut here: run ${cmd} for the rest]`;

/** cb resume, then cb role <role>, as those commands print them; '' when the pane is not bound; null when the board did
 *  not answer in time or failed. The pane's binding names the actor, as cb does without --as or $CB_ACTOR (the two
 *  differ only in a bound pane that also exports CB_ACTOR). */
async function reinject(pane, source, ms) {
  let sql;
  const work = (async () => {
    const { connect, machine, databaseUrl } = await import('../server/db.ts');
    const { openBridge, seatKey } = await import('../cli/bridge.ts');
    const { resumeText } = await import('../cli/resume-text.ts');
    // through the seat's relay when it runs (after a compaction it does): its connection is open, which saves the
    // ~800 ms a new connection to a board on another machine costs; else a connection of its own
    sql = await openBridge(seatKey(machine(), pane), databaseUrl(), undefined, { machine: machine(), pane }).catch(() => null)
      ?? connect(undefined, { max: 1, app: 'cb-hook' });
    // bound = the pane's row names a project (cb iam); the relay's own row before cb iam has none (cb start)
    const [row] = await sql`select cb.resume(s.actor) as r from cb.sessions s
      where s.machine = ${machine()} and s.pane = ${pane} and s.project is not null`;
    if (!row?.r) return '';
    const r = row.r;
    const resume = resumeText(r);
    const role = r.role ? await sql`select cb.role_text(${r.role}) as t`.then(([x]) => String(x?.t ?? ''), () => '') : '';
    // the role text is the point; the cards keep at least 1500 characters
    const roleN = role ? Math.min(role.length, CAP - Math.min(resume.length, 1500)) : 0;
    return [`Claude Board, after this ${source}: what \`cb resume\`${role ? ` and \`cb role ${r.role}\` print` : ' prints'} now.`,
      cut(resume, CAP - roleN, '`cb resume`'), role && cut(role, roleN, `\`cb role ${r.role}\``)].filter(Boolean).join('\n\n');
  })().catch(() => null);
  const late = new Promise((resolve) => setTimeout(() => resolve(null), ms));
  try { return await Promise.race([work, late]); } finally { sql?.end({ timeout: 0 }).catch(() => {}); }
}

let sent = false;
/** One write, then exit: a board connection still opening must not keep the hook alive. */
function emit(context) {
  if (sent) return;
  sent = true;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }), () => process.exit(0));
}

if (process.env.HERDR_PANE_ID) {
  let context = 'Claude Board: if this session takes work from the board, run `cb start` first and do what it prints. Manual: `cb help`.';
  // #4348: a guard nothing runs fails open, silently. A static look at the wiring (no probes: this runs at every start);
  // the fix is Ahmed's (~/.claude is inside the fence, #4345). Never let the check stop the hint.
  try {
    const { checkWiring } = await import('../kit/guard/install.mjs');
    const w = checkWiring(join(homedir(), '.claude', 'settings.json'), join(homedir(), '.claude-board', 'guard'), { probes: false });
    if (!w.ok) context += `\nGuard: ${w.problems[0]}. The command guard may not be running in this session: tell Ahmed with cb ask, and do not change ~/.claude yourself.`;
  } catch (e) {
    // review M1: a hook copied away from kit/guard loses the check; say so rather than go quiet
    context += `\nGuard: wiring check unavailable (${String(e?.message ?? e).slice(0, 120)}).`;
  }
  const backstop = setTimeout(() => emit(context), left() + 200); // nothing below may hold the start past the budget
  try {
    let source = '';
    try { source = JSON.parse(await readStdin(Math.min(left(), 1000)))?.source; } catch {}
    if (source === 'compact' || source === 'resume' || source === 'fork') {
      // review I1: until the board answers, and if it never does, the hint names the two commands to run by hand (the
      // role from the pane's CB_ROLE, which squad up sets, when it is one); a pane the board says is not bound: the hint
      const base = context;
      const role = ROLES.includes(process.env.CB_ROLE ?? '') ? process.env.CB_ROLE : '<your role>';
      context += `\nAfter this ${source} the board did not answer in time: if you hold a seat, run \`cb resume\` and \`cb role ${role}\` yourself.`;
      const block = await reinject(process.env.HERDR_PANE_ID, source, left());
      if (block !== null) context = block ? `${base}\n\n${block}` : base;
    }
  } catch {}
  clearTimeout(backstop);
  emit(context);
}
