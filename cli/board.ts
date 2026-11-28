// cb's one way to the board (#3222 S1a): a named cb.* function with named arguments, and nothing else. Today the call
// runs on Postgres, direct or through the session relay's bridge; the worker API takes this place later.
import { OPS } from '../server/ops.ts';
import { RpcError, selectFn } from '../server/rpc.ts';

let board: any;
/** The connection calls run on: cb's own, or its session relay's bridge. */
export const useBoard = (db: any) => { board = db; };

export async function call(fn: string, args: Record<string, unknown> = {}, db: any = board): Promise<any> {
  if (!Object.hasOwn(OPS, fn)) throw new RpcError(404, `unknown board function ${fn}: list it in server/ops.ts`);
  return selectFn(db, fn, args, !!OPS[fn]!.setof);
}
