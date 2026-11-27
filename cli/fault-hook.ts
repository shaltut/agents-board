// cb's side of the fault log (#4535): one synchronous 'exit' listener decides, at the very end, whether this run was a
// fault and writes its line (kit/fault-line.mjs). cb.ts only registers it and reports a few facts as the run goes
// (the error, an answer exit code, a local board started, a bridge that threw): no I/O happens until the exit, and a
// run that succeeds writes nothing.
import { homedir, hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { writeFault, mask, releaseOf } from '../kit/fault-line.mjs';
import { databaseUrl, machine } from '../server/db.ts';
import { neverSent } from './connect-retry.ts';
import { isNetworkError } from './survive.ts';
import { isAgentKind } from './agents/index.ts';

// the first word of these commands that is a subcommand (never a value: a card id, a project, a title)
const SUBS: Record<string, string[]> = {
  page: ['show', 'set'], lock: ['take', 'release', 'queue'], job: ['show', 'cancel', 'log'],
  mem: ['add', 'find', 'list', 'show', 'rule', 'supersede', 'retire'], squad: ['show', 'set', 'up'],
  huddle: ['open', 'say', 'add', 'show', 'close'], github: ['add', 'remove', 'mute', 'unmute'], asks: ['add'], user: ['add', 'role', 'password'],
};
// long-running by design: never "slow"
const NOT_SLOW = new Set(['runner', 'supervise', 'relay', 'update', 'doctor', 'triage']);
export const SLOW_MS = 5000;

type Opt = { type: string; short?: string };
type Rec = { first?: any; last?: any; stderr?: string; crash?: string; answer?: boolean; localStart?: boolean; bridgeError?: boolean };

/** The argv shape: command, subcommand, flag names, positional count, and every value (to mask in the message). */
export function argvShape(argv: string[], options: Record<string, Opt>) {
  const shorts = new Map(Object.entries(options).filter(([, o]) => o.short).map(([k, o]) => [o.short!, k]));
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
  const sub = cmd && SUBS[cmd]?.includes(argv[1] ?? '') ? argv[1]! : null;
  const flags = new Set<string>(), values: string[] = [];
  let argc = 0;
  for (let i = cmd ? (sub ? 2 : 1) : 0; i < argv.length; i++) {
    const a = argv[i]!;
    const long = /^--([a-z][a-z0-9-]*)(?:=([\s\S]*))?$/.exec(a), short = /^-([a-zA-Z])$/.exec(a);
    const name = long ? long[1]! : short ? shorts.get(short[1]!) : undefined;
    if (name && (options[name] || (cmd === 'run' && long))) {
      flags.add(name);
      if (long?.[2] !== undefined) values.push(long[2]);
      // a string option (or a free cb run --<param>) takes the next argument as its value
      else if ((options[name]?.type === 'string' || !options[name]) && i + 1 < argv.length) values.push(argv[++i]!);
      continue;
    }
    argc++;
    values.push(a);
  }
  return { cmd, sub, flags: [...flags].sort(), argc, values };
}

const isSqlState = (c: unknown) => typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c);

/** The kind of a run that failed. first: the first error cb saw (before main() rewords a network one), last: the one
 *  printed, msg: what was printed. */
export function kindOf(first: any, last: any, msg: string): string {
  const e = first ?? last;
  if (e != null) {
    if (neverSent(e)) return 'not_run';
    if (isNetworkError(e) || e?.code === 'RELAY_LOST') return 'lost';
    if (isSqlState(e?.code) && e?.code !== 'P0001' && !/^E[A-Z]+$/.test(e.code)) return 'db';
    if (!(e instanceof Error) || e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError) return 'crash';
  }
  if (/^(?:cb: )?(?:usage:|unknown (?:option|command|[a-z]+ command)|no help for)/.test(msg)) return 'usage';
  return e != null || msg ? 'refused' : 'crash';
}

/** Registers the exit listener. getSql: cb's current sql (it is replaced by the bridge and the retry wrapper), for its
 *  retry count and the pane's binding. Returns the reporters cb.ts calls. */
export function faultHook(argv: string[], options: () => Record<string, Opt>, getSql: () => any) {
  const t0 = performance.now();
  const rec: Rec = {};
  // what cb printed last on stderr: the early exits (a bad option) print and exit without throwing
  const err = console.error;
  console.error = (...a: unknown[]) => { rec.stderr = a.map(String).join(' ').slice(0, 4000); return err(...a); };
  process.on('uncaughtExceptionMonitor', (e: any) => { rec.crash = String(e?.message ?? e).slice(0, 4000); rec.last ??= e; });
  process.on('exit', (code) => {
    try { write(code, performance.now() - t0); } catch {}
  });

  function write(exit: number, ms: number) {
    const sql = (() => { try { return getSql(); } catch { return null; } })();
    const retries = Number(sql?.retries) || 0;
    const shape = argvShape(argv, options());
    const slowMs = Number(process.env.CB_FAULT_SLOW_MS) || SLOW_MS;
    const slow = ms > slowMs && !NOT_SLOW.has(shape.cmd ?? '') && !(shape.cmd === 'run' && shape.flags.includes('wait')) && !(shape.cmd === 'squad' && shape.sub === 'up');
    const failed = exit !== 0 && !rec.answer;
    let kind: string | null = null;
    const printed = (rec.crash ?? rec.stderr ?? String(rec.last?.message ?? rec.first?.message ?? '')).replace(/^cb: /, '');
    if (failed) kind = rec.crash != null ? 'crash' : kindOf(rec.first, rec.last, printed);
    else if (rec.localStart) kind = 'local_start';
    else if (shape.cmd === 'start' && rec.first) kind = kindOf(rec.first, rec.last, ''); // cb start reports and exits 0
    else if (rec.bridgeError) kind = 'bridge';
    else if (retries > 0) kind = 'retried';
    else if (slow) kind = 'slow';
    if (!kind) return;
    let url: URL | null = null;
    try { url = new URL(databaseUrl()); } catch {}
    const pane = process.env.HERDR_PANE_ID || null;
    const values = [...shape.values, url?.hostname, url?.username, url?.password, decodeURIComponent(url?.pathname.slice(1) ?? ''),
      machine(), hostname(), homedir(), pane, process.env.CB_ACTOR].filter((v): v is string => !!v);
    const e = rec.first ?? rec.last;
    const code = typeof e?.code === 'string' ? e.code : null;
    const local = url ? ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) : null;
    const agent = process.env.CB_AGENT;
    writeFault({
      machine: machine(), release: releaseOf(), src: 'cb', cmd: shape.cmd, sub: shape.sub, flags: shape.flags, argc: shape.argc,
      exit, kind, code, msg: failed || kind === 'not_run' || kind === 'lost' ? mask(printed, values) : '',
      ms, tries: rec.last?.tries ?? rec.first?.tries ?? (retries ? retries + 1 : 0),
      board: local == null ? null : local ? 'local' : 'remote', pane,
      actor: sql?.binding?.actor ?? null, agent: isAgentKind(agent) ? agent : 'claude',
    });
  }

  return {
    /** an error cb caught: the first one keeps its code (main() rewords a network error before printing it) */
    error(e: unknown) { rec.first ??= e; rec.last = e; },
    /** a non-zero exit that is the command's answer (cb lock take queued = 2, cb update --check differs = 1) */
    answer() { rec.answer = true; },
    localStart() { rec.localStart = true; },
    /** openBridge threw (not "no relay": one that is there and failing); cb goes on with a direct connection */
    bridgeError(): null { rec.bridgeError = true; return null; },
  };
}
