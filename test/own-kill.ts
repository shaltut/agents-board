// How the tests end processes (#4922). A process number is free again once its process ends, and Windows soon gives it
// to another: a cleanup that killed a stored number could end another job's Postgres, a relay or the runner on the same
// PC. So a test ends only a child that still runs, or a process whose command line carries something only its run has.
import { execFileSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';

const WIN = process.platform === 'win32';

/** Ends a child this process started, with everything it started on Windows, only while it still runs: until Node has
 *  seen it exit, its number is still its own. False when there was nothing to end. */
export function killChild(child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'> | undefined): boolean {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return false;
  if (WIN) { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  else { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
  return true;
}

/** pid → command line, for those still running; throws if Windows cannot be asked. */
function commandLines(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (WIN) {
    const q = `Get-CimInstance Win32_Process -Filter "${pids.map((p) => `ProcessId=${p}`).join(' OR ')}" -ErrorAction Stop | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`;
    const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
    for (const m of text.matchAll(/^(\d+)\t(.*)$/gm)) out.set(Number(m[1]), m[2]!);
  } else {
    for (const p of pids) {
      try { out.set(p, readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').join(' ')); } catch {
        try { out.set(p, execFileSync('ps', ['-o', 'args=', '-p', String(p)], { encoding: 'utf8', timeout: 10_000 })); } catch {}
      }
    }
  }
  return out;
}

/** Of these numbers, ends the processes whose command line contains `mark`, and returns their numbers. For processes
 *  this one did not start itself (a job's child, left behind by a killed runner). */
export function killMarked(pids: number[], mark: string): number[] {
  if (!mark) throw new Error('killMarked needs a mark: without one every command line would match');
  const ids = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (!ids.length) return [];
  const cmds = commandLines(ids);
  const killed: number[] = [];
  for (const p of ids) {
    if (!cmds.get(p)?.includes(mark)) continue;
    try { process.kill(p, 'SIGKILL'); killed.push(p); } catch {}
  }
  return killed;
}
