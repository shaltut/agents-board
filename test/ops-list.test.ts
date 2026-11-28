// #3222 S1: every board function cb names is listed in server/ops.ts, exists in db/schema.sql, is not one of the
// schema's own helpers (_name), and is read the way it returns (rows or one value). Pure: it reads source files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPS } from '../server/ops.ts';

const read = (f: string) => readFileSync(f, 'utf8');
const schema = read('db/schema.sql');

/** The function names in the first argument of each `<caller>(` call: a literal, or a choice between literals. */
const named = (src: string, caller: RegExp) => [...src.matchAll(caller)].flatMap((m) => {
  const first = /^[^,)]*/.exec(src.slice(m.index + m[0].length))![0];
  return [...first.matchAll(/(?<![=!]== )'([a-z_]+)'/g)].map((x) => x[1]!);
});

// these call call() by that name; cb.ts hands the same call() to squad-up and squad-trust, which know it as callFn
const CALL_FILES = ['cli/cb.ts', 'cli/relay.ts', 'cli/relay-refusal.ts', 'cli/jobs.ts', 'cli/usage.ts', 'cli/update-install.ts',
  'cli/stage-words.ts', 'hooks/session-start.mjs', 'hooks/usage-stop.mjs'];
const CALLED = [...new Set([
  ...CALL_FILES.flatMap((f) => named(read(f), /(?<![\w.])call\(/g)),
  ...named(read('cli/squad-up.ts'), /\bcallFn\(/g),
  ...named(read('cli/squad-trust.ts'), /\bcallFn\(/g),
])].sort();

const returnsRows = (fn: string) => {
  const m = new RegExp(String.raw`^create (?:or replace )?function cb\.${fn}\([\s\S]*?\)\s*returns\s+(setof\b|table\b)?`, 'm').exec(schema);
  assert.ok(m, `cb.${fn} is not in db/schema.sql`);
  return !!m[1];
};

test('every function cb names is listed in OPS', () => {
  assert.ok(CALLED.length > 80, `found only ${CALLED.length} names`);
  assert.deepEqual(CALLED.filter((fn) => !Object.hasOwn(OPS, fn)), [], 'add it to server/ops.ts');
});

test('OPS names no helper of the schema, only functions it has, each read as it returns', () => {
  for (const [fn, op] of Object.entries(OPS)) {
    assert.ok(!fn.startsWith('_'), `${fn}: a _name is the schema's own helper, never a board operation`);
    assert.equal(!!op.setof, returnsRows(fn), `${fn}: setof in server/ops.ts must say whether cb.${fn} returns rows`);
  }
});

test('OPS holds nothing cb does not call', () => {
  assert.deepEqual(Object.keys(OPS).filter((fn) => !CALLED.includes(fn)), []);
});
