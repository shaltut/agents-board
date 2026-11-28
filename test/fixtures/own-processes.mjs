// Preloaded (node --import) into the cb children of test/update-install.test.ts (#4919). cb update lists every process
// on the machine, so a runner of another checkout made it refuse. Here the list keeps only the lines that name
// CB_TEST_PROCESSES_NAMING (the test's own temp folder): cb still asks the real system, and judges what the test started.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const mine = process.env.CB_TEST_PROCESSES_NAMING;
if (!mine) throw new Error('own-processes.mjs needs CB_TEST_PROCESSES_NAMING');
const real = cp.spawnSync;
cp.spawnSync = (...a) => {
  const r = real(...a);
  const [cmd, args] = a;
  const listsAll = cmd === 'ps' ? args.includes('-axww') : cmd === 'powershell.exe' && args.some((x) => x.startsWith('Get-CimInstance Win32_Process |'));
  if (listsAll && r.status === 0) r.stdout = String(r.stdout).split(/\r?\n/).filter((l) => l.includes(mine)).join('\n');
  return r;
};
syncBuiltinESMExports(); // so cb's own import { spawnSync } sees it
