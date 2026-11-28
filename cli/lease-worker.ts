// The lease's renewal on a thread of its own (lease.ts keepAliveApart): it goes on while the supervisor's main thread
// is held by a seat's start. It only renews the token it is given and reports back; it never takes or releases.
import { parentPort, workerData } from 'node:worker_threads';
import { connect } from '../server/db.ts';
import { keepAlive, supervisorLease, REFUSED, UNTIL } from './lease.ts';

const { token, app, every, silentMs, sureMs, shared } = workerData as
  { token: string; app: string; every?: number; silentMs: number; sureMs?: number; shared: BigInt64Array };
let heard = Date.now(); // the main thread's last word
parentPort!.on('message', () => { heard = Date.now(); });
const tell = (what: 'abort' | 'lost' | 'say', line = '') => parentPort!.postMessage([what, line]);
const lease = supervisorLease({ connect: () => connect(undefined, { app, max: 1 }), holder: '', token, sureMs });
keepAlive(lease, { every, silent: () => Date.now() - heard > silentMs,
  kept: () => { Atomics.store(shared, UNTIL, BigInt(lease.sureUntil())); },
  abort: () => tell('abort'), say: (line) => tell('say', line),
  // marked in the shared memory first: the main thread may be held, with this message waiting
  lost: (why) => { Atomics.store(shared, REFUSED, 1n); tell('lost', why); } });
