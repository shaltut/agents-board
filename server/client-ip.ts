import type { Context } from 'hono';

// The address a failed sign-in is counted against: the hop our own proxy added (the last X-Forwarded-For entry), else a
// direct connection. Cloudflare's cf-connecting-ip only with CB_BEHIND_CLOUDFLARE=1 (a tunnel, or a proxied DNS
// record): when nginx is reachable directly, a client can send that header itself and get a fresh count on every try.
export const clientIp = (c: Context<any>) => (process.env.CB_BEHIND_CLOUDFLARE === '1' && c.req.header('cf-connecting-ip')?.trim())
  || c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || 'direct';
