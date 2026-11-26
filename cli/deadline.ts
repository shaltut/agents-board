// A deadline for an await that may never settle (#4261). A query on a dropped board connection can hang forever; at
// the top level of a long-running loop (cb supervise) Node then sees nothing pending and exits with code 13
// ("unsettled top-level await") instead of logging a failed tick. The timer here both rejects in time and keeps the
// process alive until then. The original promise is left running: the caller drops the client it came from.
export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
