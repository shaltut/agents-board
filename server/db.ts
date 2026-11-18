import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';

/** A KEY=value from the repo's .env (never cwd), so settings reach already-running sessions. */
export function dotenv(key: string): string | undefined {
  try { return readFileSync(join(import.meta.dirname, '..', '.env'), 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1].trim(); } catch {}
}

/** DATABASE_URL from CB_DATABASE_URL env, else the repo's .env. */
export function databaseUrl(): string {
  return process.env.CB_DATABASE_URL || dotenv('DATABASE_URL') || 'postgres://cb@127.0.0.1:5434/claude_board';
}

/** app names the connection in pg_stat_activity (who holds the board's connections when it runs out of them: the
 *  limit is shared by every session's relay and cb). Never 'cb-web': that name is the dashboard's (schema.sql).
 *  max: a process that queries one at a time (the relay) needs one connection, not a pool of ten. */
export function connect(url: string = databaseUrl(), o: { app?: string; max?: number } = {}) {
  // int8 → Number: ids and counts stay well below 2^53 and must be JSON-friendly.
  return postgres(url, {
    onnotice: () => {}, max: o.max ?? 10, connect_timeout: 5,
    connection: { application_name: o.app ?? process.env.PGAPPNAME ?? 'cb' },
    types: { int8: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) } } as any,
  });
}

export const sql = connect();

/** This machine's name on the board (reply_to, sessions): $CB_MACHINE or .env CB_MACHINE (e.g. "macbook", the herdr label), else the hostname. */
export function machine(): string {
  return (process.env.CB_MACHINE || dotenv('CB_MACHINE') || hostname()).toLowerCase();
}
