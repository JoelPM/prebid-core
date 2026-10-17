// libraries/sharedAdapter/sharedAdapter.js - Prebid Core runtime, Prebid.js side (paid once).
// Turns a Shared Adapter into a Prebid.js bid adapter on top of ortbConverter:
// the Host builds the generic ORTB, the Shared Adapter applies bidder-specific ORTB->ORTB edits.
import { registerBidder } from '../../src/adapters/bidderFactory.js';
import { ortbConverter } from '../ortbConverter/converter.js';

const MTYPE = { banner: 1, video: 2, native: 4 };

// `load` returns {makeRequests, makeBids, isValid}: a wasm instance (glue-*.js) or plain JS.
export function registerSharedAdapter(spec, load, context) {
  let ad;
  const get = () => ad || (ad = load());
  const meta = new WeakMap();
  const converter = ortbConverter({
    context: { netRevenue: true, ttl: 300, ...context },
    imp(buildImp, bidRequest, ctx) {
      const imp = buildImp(bidRequest, ctx);
      imp.ext = { ...imp.ext, bidder: bidRequest.params, prebid: { ...imp.ext?.prebid, adunitcode: bidRequest.adUnitCode } };
      return imp;
    },
    bidResponse(buildBidResponse, bid, ctx) {
      const r = buildBidResponse(bid, ctx);
      Object.assign(r.meta, meta.get(bid));
      return r;
    }
  });
  registerBidder({
    ...spec,
    isBidRequestValid: (bid) => get().isValid(bid),
    buildRequests(bidRequests, bidderRequest) {
      const ortb = converter.toORTB({ bidRequests, bidderRequest });
      const { request } = get().makeRequests(ortb, true);
      // keep ortbConverter's object identity (fromORTB looks its context up by reference)
      return request ? [{ method: 'POST', url: spec.url, data: Object.assign(ortb, request), options: { endpointCompression: true } }] : [];
    },
    interpretResponse(resp, req) {
      const out = get().makeBids(req.data, resp.body || {});
      const bid = out.bids.map((t) => {
        const b = { ...t.bid, mtype: MTYPE[t.type] };
        meta.set(b, t.meta);
        return b;
      });
      return converter.fromORTB({ request: req.data, response: { ...resp.body, cur: out.currency, seatbid: [{ bid }] } });
    }
  });
}
