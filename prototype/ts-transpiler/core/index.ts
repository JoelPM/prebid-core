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

// Patches only add: a field the core already produced is never overwritten (Prebid Core enforces it).
type Patch<T> = { [K in keyof T]?: T[K] extends object | undefined ? Patch<T[K]> | T[K] : T[K] } & { [k: string]: unknown };

export interface Core<P, BidExt> {
  imp(imp: Imp, p: P, req: BidRequest): Imp | Reject;
  /** `req.imp` is already the outgoing imps; `params` are their params, in order (never empty). */
  request(req: BidRequest, params: P[]): BidRequest;
  bid(bid: Bid<BidExt>, imp: Imp | undefined, resp: BidResponse<BidExt>): BidOut | Reject;
  response(resp: BidResponse<BidExt>): { currency?: string; paapi?: PaapiConfig[] };
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
    makeRequests(input: BidRequest) {
      const errs: string[] = [], imps: Imp[] = [], params: P[] = [];
      for (const imp of input.imp ?? []) {
        const p = imp.ext?.bidder as P;
        const r = def.core.imp(imp, p, input);
        if (isReject(r)) { errs.push(r.rejected); continue; }
        imps.push(x.imp ? fill(r, x.imp(imp, p, input)) : r);
        params.push(p);
      }
      if (!imps.length) return { errs };
      let o = def.core.request({ ...input, imp: imps }, params);
      if (x.request) o = fill(o, x.request({ ...input, imp: imps }, params));
      return { body: o, impIDs: imps.map((i) => i.id), errs };
    },
    makeBids(request: BidRequest, resp: BidResponse<B>) {
      const errs: string[] = [], bids: any[] = [];
      for (const sb of resp?.seatbid ?? []) for (const bid of sb.bid ?? []) {
        const imp = request?.imp?.find((i) => i.id === bid.impid);
        const r = def.core.bid(bid, imp, resp);
        if (isReject(r)) { errs.push(r.rejected); continue; }
        if (r.warning !== undefined) errs.push(r.warning);
        const meta = x.bid ? fill(r.meta ?? {}, x.bid(bid, imp).meta) : r.meta;
        bids.push({ bid: r.bid ?? bid, type: r.type, seat: r.seat, dealPriority: r.dealPriority, video: r.video, meta: nonempty(meta) });
      }
      const { currency, paapi } = def.core.response(resp);
      return { bids, currency, paapi, errs };
    },
  };
}
