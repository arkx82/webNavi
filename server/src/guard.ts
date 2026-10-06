import type { FastifyInstance, FastifyRequest } from "fastify";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as FetchInit } from "undici";

/**
 * What keeps the server's reach and its data where they belong, now that
 * it faces the internet through the tunnel:
 * - the stream relay goes only to public hosts, never into the house
 *   (the router's page, this machine's own ports);
 * - a login is counted against the driver's own address (Cloudflare's
 *   CF-Connecting-IP), not the tunnel's, which every visitor shares;
 * - a user asking for more than a car ever does is slowed down, so the
 *   national lists cannot be copied out by walking the map;
 * - the browser is told not to frame the pages or guess types.
 */

/** Whether [ip] is one no public host has: loopback, private, link-local, carrier NAT, multicast. */
export function isPrivate(ip: string): boolean {
  const v4 = unmapped(ip);
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168);
  }
  const low = v4.toLowerCase();
  return low === "::" || low === "::1" || /^f[cd]/.test(low) || /^fe[89ab]/.test(low);
}

/**
 * An IPv4 address carried inside IPv6 — ::ffff:a.b.c.d, the same in hex
 * groups as the URL parser writes it (::ffff:7f00:1), or NAT64's
 * 64:ff9b::/96 — given back as dotted IPv4, so the IPv4 rules see it.
 * Anything else (brackets off) is given back as it came.
 */
export function unmapped(ip: string): string {
  const bare = ip.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 6) return bare;
  const g = groupsOf(bare);
  if (!g) return bare;
  const mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  if (!mapped && !nat64) return bare;
  return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
}

/** The eight 16-bit groups of an IPv6 address, "::" and a dotted tail expanded. */
function groupsOf(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const dot = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dot) {
    const [a, b, c, d] = dot.slice(1).map(Number);
    s = `${s.slice(0, dot.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (h.length + t.length > 8) return null;
  const groups = [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t].map((x) => parseInt(x, 16));
  return groups.every((x) => x >= 0 && x <= 0xffff) ? groups : null;
}

/** Whether [url] is http(s) to a host that resolves to public addresses only. */
export async function isPublicUrl(url: URL): Promise<boolean> {
  if (!/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.local$|\.internal$/i.test(host)) return false;
  try {
    const found = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    return found.length > 0 && found.every((a) => !isPrivate(a.address));
  } catch {
    return false;
  }
}

/**
 * The name lookup the relay connects by: the addresses a name has at the
 * moment of connecting, and only when every one is public. So a name
 * that answered a public address to the check and a private one to the
 * connection (DNS rebinding) gets nowhere — the connection is made to
 * what was checked, never a second answer.
 */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, family: options.family }).then((found) => {
    if (!found.length || found.some((a) => isPrivate(a.address))) return callback(new RefusedUrl(hostname), []);
    if (options.all) callback(null, found);
    else callback(null, found[0].address, found[0].family);
  }, (e: Error) => callback(e, []));
};
const publicAgent = new Agent({ connect: { lookup: publicLookup } });

/**
 * fetch() for a user-given address: each redirect is checked again before
 * it is followed, and every connection goes through publicLookup. undici's
 * own fetch, as the Agent is undici's; what comes back is a Response all
 * the same.
 */
export async function fetchPublic(url: URL, init: FetchInit, hops = 3): Promise<Response> {
  for (let i = 0; ; i++) {
    if (!(await isPublicUrl(url))) throw new RefusedUrl(url.hostname);
    let answer: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      answer = await undiciFetch(url, { ...init, redirect: "manual", dispatcher: publicAgent });
    } catch (e) {
      // undici wraps what the lookup threw in "fetch failed".
      if ((e as Error).cause instanceof RefusedUrl) throw (e as Error).cause;
      throw e;
    }
    const to = answer.headers.get("location");
    // The same object at run time; only undici's typing of the header iterator differs from the global one.
    if (answer.status < 300 || answer.status >= 400 || !to) return answer as unknown as Response;
    // A redirect's body is never read: let go of it, or its connection stays taken until the GC finds it.
    await answer.body?.cancel().catch(() => undefined);
    if (i >= hops) throw new RefusedUrl("too many redirects");
    url = new URL(to, url);
  }
}

export class RefusedUrl extends Error {
  constructor(what: string) {
    super(`not a public address: ${what}`);
  }
}

/** The driver's address: Cloudflare's header when the request came through the tunnel on this machine. */
/**
 * Whether a request is for the API, read as the router reads it: the path decoded ("/%61pi/health" is
 * "/api/health" to find-my-way) and without the query. Read from the raw URL, "/%61pi/route" passed the login hook
 * and the rate limit and was routed to the keyed providers all the same (2026-10-06). A path that cannot be decoded
 * is taken as the API's: refused rather than let through.
 */
export function isApiPath(url: string): boolean {
  const raw = url.split("?")[0];
  let path: string;
  try { path = decodeURIComponent(raw); } catch { return true; }
  // "//api", "/./api", "/x/../api": what a router or a static server might fold into "/api".
  const parts: string[] = [];
  for (const p of path.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") parts.pop(); else parts.push(p);
  }
  return parts[0]?.toLowerCase() === "api";
}

export function clientIp(request: FastifyRequest): string {
  const cf = request.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf && isPrivate(request.ip)) return cf;
  return request.ip;
}

/** An entry whose minute is this far behind is let go. */
const STALE_MS = 5 * 60_000;

/**
 * Wrong logins counted under several keys at once — the address and the
 * account — so that [after] of them lock the pair out for [ms]. The
 * account's own count stands whatever address (or forged
 * CF-Connecting-IP, from the LAN) the next try claims to come from.
 */
export class Lockout {
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private after = 5, private ms = 60_000, private cap = 5000) {}

  /** Seconds any of [keys] still has to wait, or 0. */
  wait(keys: string[], now = Date.now()): number {
    let s = 0;
    for (const k of keys) {
      const f = this.failures.get(k);
      if (f && f.count >= this.after && f.until > now) s = Math.max(s, Math.ceil((f.until - now) / 1000));
    }
    return s;
  }

  /** One wrong try under each of [keys]. */
  failed(keys: string[], now = Date.now()) {
    for (const k of keys) {
      const count = (this.failures.get(k)?.count ?? 0) + 1;
      // Set anew so the map's order is by last failure: the oldest go first past the cap.
      this.failures.delete(k);
      this.failures.set(k, { count, until: now + this.ms });
    }
    for (const [k, f] of this.failures) if (f.until + STALE_MS < now) this.failures.delete(k);
    for (const k of this.failures.keys()) {
      if (this.failures.size <= this.cap) break;
      this.failures.delete(k);
    }
  }

  passed(keys: string[]) {
    for (const k of keys) this.failures.delete(k);
  }

  get size() {
    return this.failures.size;
  }
}

/**
 * Calls a user may make a minute, by kind. A drive asks the road around
 * the car every half-minute and the map's cameras as it pans; a hundred a
 * minute is far past that, and far short of copying the country out.
 */
const LIMITS: [RegExp, number][] = [
  // Map tiles come a screenful at a time as the map moves.
  [/^\/api\/hdmap\/tiles\//, 3000],
  [/^\/api\/(safety|road|nearby|here|search|route|weather|alerts)\b/, 120],
  [/^\/api\/tts\b/, 150],
  [/^\/api\//, 600],
];

export class RateLimit {
  private counts = new Map<string, { minute: number; n: number }>();

  /** Whether one more call of [path] by [who] is allowed this minute. */
  allow(who: string, path: string, now = Date.now()): boolean {
    const i = LIMITS.findIndex(([re]) => re.test(path));
    if (i < 0) return true;
    const key = `${who}|${i}`;
    const minute = Math.floor(now / 60_000);
    const c = this.counts.get(key);
    if (!c || c.minute !== minute) {
      this.counts.set(key, { minute, n: 1 });
      if (this.counts.size > 5000) this.counts.clear();
      return true;
    }
    c.n++;
    return c.n <= LIMITS[i][1];
  }
}

export function registerGuard(app: FastifyInstance) {
  const limit = new RateLimit();
  // After the login hook (users.ts) has named the user.
  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (!isApiPath(request.url) || !request.user) return;
    if (!limit.allow(String(request.user.id), path)) {
      request.log.warn({ user: request.user.name, path }, "rate limited");
      return reply.code(429).send({ error: "too many requests — 잠시 뒤에 다시" });
    }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    return payload;
  });
}
