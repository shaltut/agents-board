// The lease's renewal on a thread of its own (lease.ts keepAliveApart): it goes on while the supervisor's main thread
// is held by a seat's start. It only renews the token it is given and reports back; it never takes or releases.
import { parentPort, workerData } from 'node:worker_threads';
import { connect } from '../server/db.ts';
import { keepAlive, supervisorLease } from './lease.ts';

const { token, app, every, silentMs } = workerData as { token: string; app: string; every?: number; silentMs: number };
let heard = Date.now(); // the main thread's last word
parentPort!.on('message', () => { heard = Date.now(); });
const tell = (what: 'abort' | 'lost' | 'say', line = '') => parentPort!.postMessage([what, line]);
keepAlive(supervisorLease({ connect: () => connect(undefined, { app, max: 1 }), holder: '', token }),
  { every, silent: () => Date.now() - heard > silentMs, abort: () => tell('abort'), lost: (why) => tell('lost', why), say: (line) => tell('say', line) });
