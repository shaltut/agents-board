// #4922: how the runner tests clean up. A process number is free again once its process ends, and Windows soon gives it
// to another: on a PC that runs many jobs at once that can be another job's Postgres, a relay or the runner. Looking the
// number up first is not enough (the process can end between the look and the kill), so the cleanup kills by no number:
// it ends its own children through their handles, and the long job step ends by itself when told. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the runner tests end no process by its number', () => {
  const src = readFileSync('test/runner.test.ts', 'utf8');
  // signal 0 only asks whether the number is in use
  const byNumber = /taskkill|killTree|killMarked|killChild|Stop-Process|process\.kill\((?![^()]*,\s*0\))/;
  assert.deepEqual(src.split('\n').filter((l) => byNumber.test(l)), []);
});

test('the long job step says its number, runs on, and leaves by itself once the stop file is there', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-slow-'));
  const stop = join(dir, 'stop'), script = join(dir, 'slow.mjs');
  writeFileSync(script, readFileSync('test/fixtures/slow.mjs', 'utf8').replace("'__STOP__'", () => JSON.stringify(stop)));
  const c = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>((r) => c.once('exit', (code) => r(code)));
  try {
    const said = await new Promise<string>((r) => c.stdout!.once('data', (b) => r(String(b))));
    assert.equal(said.trim(), `pid ${c.pid}`);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(c.exitCode, null, 'it left before it was told to');
    writeFileSync(stop, '');
    const late = new Promise<string>((r) => setTimeout(() => r('still running'), 10_000).unref());
    assert.equal(await Promise.race([exited, late]), 0);
  } finally {
    c.kill('SIGKILL'); // by its handle; nothing to do once it has left
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
