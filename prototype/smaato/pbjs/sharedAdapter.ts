// PROTOTYPE Prebid Core, Prebid.js Host glue (libraries/sharedAdapter): paid once per bundle.
// The Host builds generic ORTB with ortbConverter; the Shared Adapter applies its ORTB -> ORTB edits;
// bids go back through ortbConverter so Prebid.js-only fields (ttl, netRevenue, currency) stay the
// Host's. Params travel in imp.ext.bidder, the ad unit code in imp.ext.prebid.adunitcode.
import { registerBidder } from '../../src/adapters/bidderFactory.js';
import { ortbConverter } from '../ortbConverter/converter.js';
import { getGlobal } from '../../src/prebidGlobal.js';

// the Host context Phases see in Prebid.js; currency through the currency module when it's installed
const host: any = {
  entryPoint: 'auction',
  now: () => Date.now(),
  convertCurrency(a: number, from: string, to: string) {
    try {
      const v = (getGlobal() as any).convertCurrency?.(a, from, to);
      return typeof v === 'number' && isFinite(v) ? v : undefined;
    } catch {
      return undefined;
    }
  },
};

const MTYPE: any = { banner: 1, video: 2, audio: 3, native: 4 };

export function registerSharedAdapter(spec: any, sa: any, context: any = {}) {
  const extra = new WeakMap();
  const converter = ortbConverter({
    context: { netRevenue: true, ttl: 300, ...context },
    imp(buildImp, bidRequest: any, ctx) {
      const imp: any = buildImp(bidRequest, ctx);
      imp.ext = { ...imp.ext, bidder: bidRequest.params, prebid: { ...imp.ext?.prebid, adunitcode: bidRequest.adUnitCode } };
      return imp;
    },
    bidResponse(buildBidResponse, bid: any, ctx) {
      const r: any = buildBidResponse(bid, ctx);
      const x = extra.get(bid);
      if (x?.meta) Object.assign(r.meta, x.meta);
      if (x?.dealPriority) r.dealPriority = x.dealPriority;
      return r;
    }
  } as any);
  registerBidder({
    ...spec,
    isBidRequestValid: (b: any) => sa.isValid(b.params),
    buildRequests(bidRequests: any, bidderRequest: any) {
      const ortb: any = converter.toORTB({ bidRequests, bidderRequest });
      // one ServerRequest per outgoing request; each keeps the ORTB request ortbConverter made
      // (fromORTB looks its context up by reference)
      return sa.makeRequests(ortb, host).requests.map((r: any) => ({ method: 'POST', url: sa.endpoint, data: r.body, ortb, options: { endpointCompression: true } }));
    },
    interpretResponse(resp: any, req: any) {
      const http = { status: 200, header: (n: string) => resp.headers?.get?.(n) ?? undefined };
      const out = sa.makeBids(req.data, resp.body || {}, http, host);
      const bid = out.bids.map((t: any) => {
        const b = { ...t.bid, mtype: MTYPE[t.type] };
        extra.set(b, t);
        return b;
      });
      return converter.fromORTB({ request: req.ortb, response: { ...resp.body, cur: out.currency, seatbid: [{ bid }] } } as any);
    }
  } as any);
}
