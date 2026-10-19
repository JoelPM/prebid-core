// PROTOTYPE Prebid Core, Prebid.js Host glue (libraries/sharedAdapter): paid once per bundle.
// The Host builds generic ORTB with ortbConverter; the Shared Adapter applies its ORTB -> ORTB edits;
// bids go back through ortbConverter so Prebid.js-only fields (ttl, netRevenue, currency) stay the
// Host's. Params travel in imp.ext.bidder, the ad unit code in imp.ext.prebid.adunitcode.
import { registerBidder } from '../../src/adapters/bidderFactory.js';
import { ortbConverter } from '../ortbConverter/converter.js';

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
      const { body } = sa.makeRequests(ortb);
      // keep ortbConverter's object identity (fromORTB looks its context up by reference)
      return body ? [{ method: 'POST', url: sa.endpoint, data: Object.assign(ortb, body), options: { endpointCompression: true } }] : [];
    },
    interpretResponse(resp: any, req: any) {
      const out = sa.makeBids(req.data, resp.body || {});
      const bid = out.bids.map((t: any) => {
        const b = { ...t.bid, mtype: MTYPE[t.type] };
        extra.set(b, t);
        return b;
      });
      return converter.fromORTB({ request: req.data, response: { ...resp.body, cur: out.currency, seatbid: [{ bid }] } } as any);
    }
  } as any);
}
