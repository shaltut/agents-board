// cb key (#3222 S3): puts this machine's board key where cb, the relay and the hooks find it, and asks the board who
// it is. A board key is never logged, printed, copied or put in an error, so no word the caller typed is repeated here:
// a key typed as an argument would be one of them. Errors carry no code: cb must not take them for its database being
// down.
import { releaseOf } from '../kit/fault-line.mjs';
import { dotenv, machine } from '../server/db.ts';
import { apiBoard } from './board.ts';
import { chooseTransport, installKey, KINDS, type Kind } from './transport.ts';

type Opts = { input?: () => Promise<string>; tty?: boolean; env?: Record<string, string | undefined>; file?: (key: string) => string | undefined };

const USE = 'use cb key install <machine|runner|supervisor> (the key on stdin) or cb key check [machine|runner|supervisor]';

async function stdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function kindOf(word: string): Kind {
  if (!(KINDS as readonly string[]).includes(word)) throw new Error('a key is for machine, runner or supervisor');
  return word as Kind;
}

export async function keyCmd(args: string[], o: Opts = {}): Promise<string> {
  const env = o.env ?? process.env, file = o.file ?? dotenv;
  const [sub, word, ...rest] = args;
  if (sub === 'install' && word !== undefined) {
    const kind = kindOf(word);
    if (rest.length) {
      throw new Error('the key goes on stdin, never as an argument. A key typed on a command line stays in its history: ask the owner to revoke it and issue another');
    }
    if (o.tty ?? process.stdin.isTTY) throw new Error(`pipe the key into cb key install ${kind}: typed here it would show on the screen`);
    const path = installKey(kind, await (o.input ?? stdin)(), env);
    const address = env.CB_BOARD_URL || file('CB_BOARD_URL') ? ''
      : '\nSet CB_BOARD_URL, the board\'s https address, in .env: without it this machine does not use the key.';
    return `stored the ${kind} key in ${path}. Check it: cb key check ${kind}${address}`;
  }
  if (sub === 'check' && !rest.length) {
    const kind = kindOf(word ?? 'machine');
    // the API even where cb still goes to its database: this asks about the key
    const target = chooseTransport(kind, { ...env, CB_DATABASE_URL: '' }, file);
    if (target.mode !== 'api') throw new Error(`set CB_BOARD_URL, the board's https address, in .env or the environment, then cb key check ${kind}`);
    const board = apiBoard({ url: target.url, keyFile: target.keyFile, code: releaseOf() ?? 'unknown' });
    let who: any;
    try { who = await board.hello(); } catch (e: any) {
      throw new Error(`could not check the ${kind} key with the board at ${target.url}: ${e?.message || e?.code}`);
    } finally { await board.end(); }
    if (who.kind !== kind) throw new Error(`the key in ${target.keyFile} is a ${who.kind} key, not a ${kind} key: install the right one with cb key install ${kind}`);
    const mine = (env.CB_MACHINE || machine()).toLowerCase();
    return [`the board at ${target.url} takes key ${who.key}: kind ${who.kind}, machine ${who.machine}${who.runner ? `, runner ${who.runner}` : ''} (board release ${who.release})`,
      ...(kind === 'machine' && who.machine !== mine
        ? [`This machine calls itself ${mine}, so the board would refuse its writes: set CB_MACHINE=${who.machine} in .env.`] : [])].join('\n');
  }
  throw new Error(USE);
}
