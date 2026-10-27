// PROTOTYPE Prebid Core, TS Implementation: what a Shared Adapter imports, and the driver every
// Host's TS side runs it with. The transpiler (transpiler/) reproduces exactly these semantics in Rust.
// Erasable TS only (no enums/namespaces) so Node can run it with type stripping.
import type { Bid, BidRequest, BidResponse, Imp, Json, JsonObject } from './ortb.ts';
export type { Bid, BidRequest, BidResponse, Imp, Json, JsonObject } from './ortb.ts';

// ---------- what Adapters call ----------

export interface Reject { readonly rejected: string }
/** Drop this imp (in `imp`) or bid (in `bid`) and report `message` as an error. */
export const reject = (message: string): Reject => ({ rejected: message });

/** A string, or a number/boolean printed the way String() does; otherwise undefined. */
export const str = (x: unknown): string | undefined =>
  typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : undefined;
/** A number, or a string that is entirely a decimal number; otherwise undefined. */
export const num = (x: unknown): number | undefined =>
  typeof x === 'number' ? x : typeof x === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(x) ? +x : undefined;
/** An integer, or a string of decimal digits; otherwise undefined. */
export const int = (x: unknown): number | undefined =>
  typeof x === 'number' ? (Number.isInteger(x) ? x : undefined) : typeof x === 'string' && /^[+-]?\d+$/.test(x) ? +x : undefined;
/** x if it is a JSON object (not null, not an array); otherwise undefined. */
export const obj = (x: unknown): JsonObject | undefined => (isObj(x) ? (x as JsonObject) : undefined);
/** undefined for '', [], and objects with no defined member; otherwise x. */
export function nonempty<T>(x: T): T | undefined {
  if (x === '' || (Array.isArray(x) && !x.length)) return undefined;
  if (isObj(x) && !Object.values(x).some((v) => v !== undefined)) return undefined;
  return x;
}
/** A copy of an object without the given keys; undefined if it isn't an object. */
export function without<T extends object>(o: T | undefined, ...ks: string[]): Partial<T> | undefined {
  if (!isObj(o)) return undefined;
  const r: any = { ...o };
  for (const k of ks) delete r[k];
  return r;
}
/** application/x-www-form-urlencoded escaping (Go's url.QueryEscape): every byte of the UTF-8 encoding
 * except A-Z a-z 0-9 - _ . ~ is %XX (upper-case hex), and a space is '+'. */
export function formEncode(s: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
    else if (b === 0x20) out += '+';
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** JSON.parse that returns undefined instead of throwing. */
export function parseJson(s: string | undefined): Json | undefined {
  try {
    return typeof s === 'string' ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
}

// ---------- what Adapters are ----------

export type MediaType = 'banner' | 'video' | 'audio' | 'native';
export interface BidOut {
  bid?: Bid<any>; // the outgoing bid; defaults to the bidder's own
  type: MediaType;
  seat?: string;
  dealPriority?: number;
  video?: { primary_category?: string; duration?: number };
  meta?: JsonObject | { [k: string]: Json | undefined };
  warning?: string; // reported as an error; the bid is kept
}
export interface PaapiConfig { impid: string; config: Json }

/** What the Host provides beyond its inputs. */
export interface HostContext {
  /** 'auction' (the default), 'video' (PBS's video endpoint) or 'amp' */
  entryPoint: 'auction' | 'video' | 'amp';
  /** milliseconds since the epoch, as the Host's clock says */
  now(): number;
  /** the Host's currency service; undefined when it has no rate */
  convertCurrency(amount: number, from: string, to: string): number | undefined;
}
/** The bidder's HTTP response, beyond its body. */
export interface Http {
  status: number;
  /** a response header (case-insensitive name); undefined when absent */
  header(name: string): string | undefined;
}

// Patches only add: a field the core already produced is never overwritten (Prebid Core enforces it).
type Patch<T> = { [K in keyof T]?: T[K] extends object | undefined ? Patch<T[K]> | T[K] : T[K] } & { [k: string]: unknown };

export interface Core<P, BidExt> {
  /** One outgoing imp, several (a split), or reject. */
  imp(imp: Imp, p: P, req: BidRequest, host: HostContext): Imp | Imp[] | Reject;
  /** Which outgoing request an outgoing imp goes in (same key, same request; first-seen order).
   * Without it, all imps go in one request. */
  group?(imp: Imp, p: P, host: HostContext): string;
  /** Once per outgoing request. `req.imp` is that request's imps; `params` their params, in order
   * (never empty). Rejecting drops that request. */
  request(req: BidRequest, params: P[], host: HostContext): BidRequest | Reject;
  bid(bid: Bid<BidExt>, imp: Imp | undefined, resp: BidResponse<BidExt>, http: Http, host: HostContext): BidOut | Reject;
  /** Runs before the bids; rejecting drops every bid. */
  response(resp: BidResponse<BidExt>, http: Http, host: HostContext): { currency?: string; paapi?: PaapiConfig[] } | Reject;
}
export interface Extension<P, BidExt> {
  endpoint?: string;
  imp?(imp: Imp, p: P, req: BidRequest): Patch<Imp>;
  request?(req: BidRequest, params: P[]): Patch<BidRequest>;
  bid?(bid: Bid<BidExt>, imp: Imp | undefined): { meta?: { [k: string]: Json | undefined } };
}
export interface AdapterDef<P, BidExt> {
  bidder: string;
  endpoint: string;
  /** Required params, and groups of which at least one must be fully present (the params schema's `required`/`anyOf`). */
  required?: { all?: string[]; anyOf?: string[][] };
  core: Core<P, BidExt>;
  client?: Extension<P, BidExt>;
  server?: Extension<P, BidExt>;
}
export const defineAdapter = <P, BidExt = JsonObject>(def: AdapterDef<P, BidExt>) => def;

// ---------- the driver (Host side, TS): what PBS-Go's generated Rust driver also does ----------

const defaultHost: HostContext = { entryPoint: 'auction', now: () => Date.now(), convertCurrency: () => undefined };
const defaultHttp: Http = { status: 200, header: () => undefined };

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const isReject = (x: unknown): x is Reject => isObj(x) && typeof x.rejected === 'string' && Object.keys(x).length === 1;

/** Add-only patch: fills fields `o` lacks, recursing into objects both have. Never mutates `o`. */
export function fill(o: any, patch: any): any {
  if (!isObj(patch)) return o;
  let r = o;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === undefined) continue;
    if (r[k] === undefined) r = { ...r, [k]: v };
    else if (isObj(r[k]) && isObj(v)) {
      const c = fill(r[k], v);
      if (c !== r[k]) r = { ...r, [k]: c };
    }
  }
  return r;
}

export function build<P, B>(def: AdapterDef<P, B>, side: 'client' | 'server') {
  const x = def[side] ?? {};
  const req = def.required ?? {};
  return {
    bidder: def.bidder,
    endpoint: x.endpoint ?? def.endpoint,
    isValid: (p: any): boolean =>
      p != null && (req.all ?? []).every((k) => p[k] != null) && (!req.anyOf || req.anyOf.some((g) => g.every((k) => p[k] != null))),
    makeRequests(input: BidRequest, host: HostContext = defaultHost) {
      const errs: string[] = [];
      const groups = new Map<string, { imps: Imp[]; params: P[] }>();
      for (const imp of input.imp ?? []) {
        const p = imp.ext?.bidder as P;
        const r = def.core.imp(imp, p, input, host);
        if (isReject(r)) { errs.push(r.rejected); continue; }
        for (const one of Array.isArray(r) ? r : [r]) {
          const o = x.imp ? fill(one, x.imp(imp, p, input)) : one;
          const key = def.core.group ? def.core.group(o, p, host) : '';
          if (!groups.has(key)) groups.set(key, { imps: [], params: [] });
          groups.get(key)!.imps.push(o);
          groups.get(key)!.params.push(p);
        }
      }
      const requests: { body: BidRequest; impIDs: string[] }[] = [];
      for (const { imps, params } of groups.values()) {
        const r = def.core.request({ ...input, imp: imps }, params, host);
        if (isReject(r)) { errs.push(r.rejected); continue; }
        const o = x.request ? fill(r, x.request({ ...input, imp: imps }, params)) : r;
        requests.push({ body: o, impIDs: imps.map((i) => i.id) });
      }
      return { requests, errs };
    },
    makeBids(request: BidRequest, resp: BidResponse<B>, http: Http = defaultHttp, host: HostContext = defaultHost) {
      const errs: string[] = [], bids: any[] = [];
      const top = def.core.response(resp, http, host);
      if (isReject(top)) return { bids, currency: undefined, paapi: undefined, errs: [top.rejected], rejected: true };
      for (const sb of resp?.seatbid ?? []) for (const bid of sb.bid ?? []) {
        const imp = request?.imp?.find((i) => i.id === bid.impid);
        const r = def.core.bid(bid, imp, resp, http, host);
        if (isReject(r)) { errs.push(r.rejected); continue; }
        if (r.warning !== undefined) errs.push(r.warning);
        const meta = x.bid ? fill(r.meta ?? {}, x.bid(bid, imp).meta) : r.meta;
        bids.push({ bid: r.bid ?? bid, type: r.type, seat: r.seat, dealPriority: r.dealPriority, video: r.video, meta: nonempty(meta) });
      }
      return { bids, currency: top.currency, paapi: top.paapi, errs };
    },
  };
}
