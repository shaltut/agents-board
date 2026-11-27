// A script's own path as it was started (#4352). cb update installs a release in <home>/versions/<sha>/ and points the
// copy's path at it with a link. Node gives import.meta.filename as the real path (the old version), but the path a
// hook started the relay with (process.argv[1]) stays the link. Watching and relaunching through that path makes a
// flip restart the relay into the new code, as a tar extract over a plain copy always has. cb relay starts it the same way.
import { basename, resolve } from 'node:path';

export function startedAs(argv1: string | undefined, metaFile: string): string {
  return argv1 && basename(argv1) === basename(metaFile) ? resolve(argv1) : metaFile;
}
