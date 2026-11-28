// How a worker reaches the board (#3222 S3, page 3222 3.8), and its key file.
// A board key is never logged, printed, copied or put in an error: nothing here repeats what it read.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dotenv } from '../server/db.ts';

export const KINDS = ['machine', 'runner', 'supervisor'] as const;
export type Kind = (typeof KINDS)[number];
export type Transport = { mode: 'db' } | { mode: 'api'; url: string; keyFile: string };

type Env = Record<string, string | undefined>;
const KEY = /^cbk1_[0-9a-f]{10}_[A-Za-z0-9_-]{43}$/;
const OWN_HOST = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const keyDir = (env: Env = process.env) => env.CB_KEY_DIR || join(homedir(), '.claude-board', 'keys');

export function keyFile(kind: Kind, env: Env = process.env) {
  if (!KINDS.includes(kind)) throw new Error('a key is for machine, runner or supervisor');
  return join(keyDir(env), `${kind}.key`);
}

/** The board's address, without a trailing slash. The key travels with every call: https, or this machine itself. */
export function boardUrl(text: string): string {
  const u = URL.canParse(text) ? new URL(text) : null;
  const safe = !!u && (u.protocol === 'https:' || (u.protocol === 'http:' && OWN_HOST.has(u.hostname)));
  if (!u || !safe || u.username || u.password || u.search || u.hash) {
    throw new Error('CB_BOARD_URL must be the board\'s https address, with no user, query or # part (plain http only for this machine itself)');
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/** CB_DATABASE_URL in the environment: the database. Else a board address (env or .env) with this kind's key: the API.
 *  Else the database from .env. An address without a key is an error: the API never falls back to the database. */
export function chooseTransport(kind: Kind, env: Env = process.env, file: (key: string) => string | undefined = dotenv): Transport {
  if (env.CB_DATABASE_URL) return { mode: 'db' };
  const url = env.CB_BOARD_URL || file('CB_BOARD_URL');
  if (!url) return { mode: 'db' };
  const path = keyFile(kind, env);
  if (!existsSync(path)) {
    throw new Error(`CB_BOARD_URL is set but this machine has no ${kind} key: pipe the one the owner issued into cb key install ${kind}`);
  }
  return { mode: 'api', url: boardUrl(url), keyFile: path };
}

export function readKey(path: string): string {
  const key = readFileSync(path, 'utf8').trim();
  if (!KEY.test(key)) throw new Error(`the key file ${path} does not hold a board key: install it again with cb key install`);
  return key;
}

/** Stores a key as this kind's, readable by this user only. Returns the file's path. */
export function installKey(kind: Kind, text: string, env: Env = process.env): string {
  const path = keyFile(kind, env), key = text.trim();
  if (!KEY.test(key)) throw new Error('that is not a board key (cbk1_...): pipe in the one line the board printed when it was issued');
  mkdirSync(keyDir(env), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${key}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path); // a relay reading it sees the old key or the new one, never half of one
  } finally {
    rmSync(tmp, { force: true });
  }
  return path;
}
