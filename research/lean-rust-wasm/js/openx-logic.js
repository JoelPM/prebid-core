// The same ORTB->ORTB OpenX logic as ox-lean/src/openx.rs, hand-written in plain JS, to size
// what wasm costs relative to a JS/TS Shared Adapter on the same runtime (Form B in Prebid.js).
const truthy = (v) => !!v;
const posNum = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? +v : NaN) > 0;
export function makeRequests(req, client) {
  const out = {}, errors = [], imps = [];
  let first, delDomain, platform;
  for (const imp of req.imp || []) {
    if (!(imp.banner || imp.video || imp.native)) continue;
    const ext = imp.ext || {}, p = ext.bidder;
    if (!p || typeof p !== 'object') { errors.push('imp.ext.bidder: expected an object'); continue; }
    first = first || p;
    delDomain = p.delDomain; platform = p.platform;
    if (p.unit != null && String(p.unit)) imp.tagid = String(p.unit);
    if (!posNum(imp.bidfloor) && posNum(p.customFloor)) imp.bidfloor = +p.customFloor;
    const { prebid, bidder, ...x } = ext;
    if (p.customParams && typeof p.customParams === 'object') x.customParams = p.customParams;
    if (client && prebid?.adunitcode) x.divid = prebid.adunitcode;
    if (Object.keys(x).length) imp.ext = x; else delete imp.ext;
    if (imp.video) {
      const v = { ...imp.video };
      if (client) Object.assign(v, p.video);
      else if (imp.rwdd == 1) v.ext = { rewarded: 1 }; else delete v.ext;
      imp.video = v;
    }
    imps.push(imp);
  }
  if (imps.length) {
    req.imp = imps;
    let ext;
    if (client) {
      ext = { ...req.ext, bc: 'hb_pb_ortb_2.0' };
      delDomain = first.delDomain; platform = first.platform;
      req.at = 1;
      req.device = { ...req.device, dnt: 0 };
      if (first.coppa) req.regs = { ...req.regs, coppa: 1 };
      if (first.response_template_name) ext.response_template_name = first.response_template_name;
      if (first.test) req.test = 1;
    } else ext = { bc: 'hb_pbs_1.0.0' };
    if (truthy(delDomain)) ext.delDomain = delDomain;
    if (truthy(platform)) ext.platform = platform;
    req.ext = ext;
    out.request = req;
  }
  if (errors.length) out.errors = errors;
  return out;
}
export function isValid(bid) {
  const p = bid.params, dd = p.delDomain || p.platform, banner = bid.mediaTypes?.banner;
  return banner && dd ? !!p.unit || banner.sizes?.length > 0 : !!(p.unit && dd);
}
const TYPES = { 1: 'banner', 2: 'video', 4: 'native' };
export function makeBids(req, resp) {
  const out = { currency: resp.cur || 'USD', bids: [] };
  const fac = resp.ext?.fledge_auction_configs;
  if (fac) out.fledgeauctionconfigs = Object.entries(fac).map(([impid, config]) => ({ impid, bidder: 'openx', config }));
  for (const sb of resp.seatbid || []) for (const bid of sb.bid || []) {
    let type = TYPES[bid.mtype];
    if (!type) {
      const imp = (req.imp || []).find((i) => i.id === bid.impid);
      type = imp && !imp.banner ? (imp.video ? 'video' : imp.native ? 'native' : 'banner') : 'banner';
    }
    const tb = { bid, type, video: { primary_category: typeof bid.cat?.[0] === 'string' ? bid.cat[0] : '', duration: typeof bid.dur === 'number' ? bid.dur : 0 } };
    const id = (v) => (posNum(v) ? +v : undefined), x = bid.ext || {};
    const m = { networkId: id(x.dsp_id), advertiserId: id(x.buyer_id), brandId: id(x.brand_id) };
    if (m.networkId || m.advertiserId || m.brandId) tb.meta = { networkId: m.networkId || 0, advertiserId: m.advertiserId || 0, brandId: m.brandId || 0 };
    out.bids.push(tb);
  }
  return out;
}
