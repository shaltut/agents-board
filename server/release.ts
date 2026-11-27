// The release this board serves (#4352 slice 2): GET /release/current.json (the manifest, plus the archive's name,
// sha256 and size) and GET /release/<sha>.tgz (the archive). No sign-in, like /healthz: the archive is the public
// repo's own tracked files at one commit, never an env file or node_modules (cli/release-archive.ts refuses them).
// Read-only and from memory: built once at start, served by exact name, no path ever built from the URL.
import { Hono } from 'hono';
import { releaseAt, type Release } from '../cli/release-archive.ts';
import { compareManifest } from '../cli/release.ts';

let current: Release | null = null;
let why = 'not built yet';

/** Build the release from root (at server start). A failure leaves the board up with no release, and says why in the
 *  log. The archive must be the code this board runs: a stale release.tgz left on the host from an earlier deploy would
 *  otherwise be baked into a new image and announce an old commit, telling current workers they are behind. */
export function loadRelease(root: string) {
  try {
    const r = releaseAt(root);
    const d = compareManifest(root, r.manifest);
    const off = [...d.missing, ...d.changed, ...d.extra, ...d.outside];
    if (off.length) throw new Error(`the archive (${r.manifest.sha.slice(0, 7)}) is not the code this board runs: ${off.length} files differ (${off.slice(0, 5).join(', ')}${off.length > 5 ? ', ...' : ''}); make release.tgz again at deploy (docs/ops/maintain.md, Upgrade)`);
    current = r;
    why = '';
    console.log(`release: serving ${current.manifest.sha.slice(0, 7)} (${Object.keys(current.manifest.files).length} files)`);
  } catch (e: any) {
    current = null;
    why = String(e?.message ?? e);
    console.error(`release: none served: ${why}`);
  }
}
/** For tests: serve this release (or none, with the reason). */
export function setRelease(r: Release | null, reason = 'none') { current = r; why = r ? '' : reason; }
/** Why none is served (the log's words; tests read it). Never sent to a client: it holds paths and git's errors. */
export const releaseWhy = () => why;

const none = (c: any) => c.json({ ok: false, error: "this board serves no release: its log says why (release: none served)" }, 404);

export const releaseApp = new Hono();
releaseApp.get('/release/current.json', (c) => {
  if (!current) return none(c);
  const { manifest, tgz, sha256, deps } = current;
  c.header('Cache-Control', 'no-store');
  return c.json({ ...manifest, archive: { name: `${manifest.sha}.tgz`, sha256, bytes: tgz.length }, deps: deps ?? null });
});
releaseApp.get('/release/:file', (c) => {
  if (!current) return none(c);
  if (c.req.param('file') !== `${current.manifest.sha}.tgz`) return c.json({ ok: false, error: `not this board's release: GET /release/current.json names it` }, 404);
  return c.body(new Uint8Array(current.tgz), 200, { 'Content-Type': 'application/gzip', 'Cache-Control': 'public, max-age=31536000, immutable' });
});
// anything deeper is no release either: never the UI's index.html with a 200
releaseApp.all('/release/*', (c) => c.json({ ok: false, error: 'not found: GET /release/current.json' }, 404));
