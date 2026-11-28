// The long job step of test/runner.test.ts, written into its repo as slow.mjs. It says its process number and runs for
// 60 s, or until the stop file is there: so the tests' cleanup never has to kill it by that number (#4922).
import { existsSync } from 'node:fs';

const stop = '__STOP__';
console.log('pid ' + process.pid);
setTimeout(() => process.exit(0), 60_000);
setInterval(() => { if (existsSync(stop)) process.exit(0); }, 200);
