// #4762: the bash these tests mean. On Windows a PATH that lists System32 before Git (the PC runner's) finds WSL's
// launcher as "bash": it has no node and no C:/ paths, and it reads its -c text in a second shell, which runs what the
// first one had quoted. Seats and the commands cb prints are used in Git's bash, so the tests run that one.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function find(): string {
  if (process.platform !== 'win32') return 'bash';
  // <git>/mingw64/libexec/git-core (or its arm64 folder) -> <git>/bin/bash.exe
  const exe = resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe');
  if (!existsSync(exe)) throw new Error(`no Git bash at ${exe}: these tests need Git for Windows`);
  return exe;
}
export const BASH = find();
