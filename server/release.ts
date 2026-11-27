// The release this board serves (#4352 slice 2): GET /release/current.json (the manifest, plus the archive's name,
// sha256 and size) and GET /release/<sha>.tgz (the archive). No sign-in, like /healthz: the archive is the public
// repo's own tracked files at one commit, never an env file or node_modules (cli/release-archive.ts refuses them).
// Read-only and from memory: built once at start, served by exact name, no path ever built from the URL.
import { Hono } from 'hono';
import { releaseAt, type Release } from '../cli/release-archive.ts';

let current: Release | null = null;
let why = 'not built yet';

/** Build the release from root (at server start). A failure leaves the board up with no release, and says why. */
export function loadRelease(root: string) {
  try {
    current = releaseAt(root);
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

const none = (c: any) => c.json({ ok: false, error: `this board serves no release: ${why}` }, 404);

export const releaseApp = new Hono();
releaseApp.get('/release/current.json', (c) => {
  if (!current) return none(c);
  const { manifest, tgz, sha256 } = current;
  c.header('Cache-Control', 'no-store');
  return c.json({ ...manifest, archive: { name: `${manifest.sha}.tgz`, sha256, bytes: tgz.length } });
});
releaseApp.get('/release/:file', (c) => {
  if (!current) return none(c);
  if (c.req.param('file') !== `${current.manifest.sha}.tgz`) return c.json({ ok: false, error: `not this board's release: GET /release/current.json names it` }, 404);
  return c.body(new Uint8Array(current.tgz), 200, { 'Content-Type': 'application/gzip', 'Cache-Control': 'public, max-age=31536000, immutable' });
});
// anything deeper is no release either: never the UI's index.html with a 200
releaseApp.all('/release/*', (c) => c.json({ ok: false, error: 'not found: GET /release/current.json' }, 404));
