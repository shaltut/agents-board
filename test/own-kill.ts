// How the tests end processes. This first form does what the runner tests' cleanup did: it ends whatever has the number.
import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

const tree = (pid: number) => {
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  else { try { process.kill(pid, 'SIGKILL'); } catch {} }
};

export function killChild(child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'> | undefined): boolean {
  if (!child?.pid) return false;
  tree(child.pid);
  return true;
}

export function killMarked(pids: number[], mark: string): number[] {
  for (const p of pids) try { process.kill(p, 'SIGKILL'); } catch {}
  return pids;
}
