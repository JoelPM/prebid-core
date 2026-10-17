// Hand port of PBS-Go adapters/openx/openx.go (MakeRequests + MakeBids) to plain JS.
const HBCONFIG = "hb_pbs_1.0.0";
function makeRequests(request) {
  const reqExt = { bc: HBCONFIG };
  const validImps = [];
  const errs = [];
  for (const src of request.imp) {
    if (!src.banner && !src.video && !src.native) continue;
    const imp = Object.assign({}, src);
    const ext = imp.ext || {};
    const ox = ext.bidder;
    if (!ox || typeof ox !== "object") { errs.push("bad bidder ext"); continue; }
    if (ox.delDomain) reqExt.delDomain = ox.delDomain;
    if (ox.platform) reqExt.platform = ox.platform;
    imp.tagid = String(ox.unit);
    if (!imp.bidfloor) { const f = Number(ox.customFloor); if (f > 0) imp.bidfloor = f; }
    const impExt = Object.assign({}, ext);
    delete impExt.prebid; delete impExt.bidder;
    if (ox.customParams != null) impExt.customParams = ox.customParams;
    if (Object.keys(impExt).length > 0) imp.ext = impExt; else delete imp.ext;
    if (imp.video) {
      const v = Object.assign({}, imp.video);
      if (imp.rwdd === 1) v.ext = { rewarded: 1 }; else delete v.ext;
      imp.video = v;
    }
    validImps.push(imp);
  }
  if (validImps.length === 0) return { reqs: [], errs };
  const out = Object.assign({}, request, { imp: validImps, ext: reqExt });
  return {
    reqs: [{ method: "POST", uri: "http://rtb.openx.net/prebid", body: JSON.stringify(out),
      headers: { "Content-Type": "application/json;charset=utf-8", Accept: "application/json" },
      impIDs: validImps.map((i) => i.id) }],
    errs,
  };
}
function mediaTypeForImp(impId, imps) {
  for (const imp of imps) if (imp.id === impId) {
    if (!imp.banner && imp.video) return "video";
    if (!imp.banner && imp.native) return "native";
    return "banner";
  }
  return "banner";
}
function makeBids(internalReq, status, body) {
  if (status === 204) return null;
  if (status !== 200) throw new Error("Unexpected status code: " + status);
  const r = JSON.parse(body);
  const res = { currency: r.cur || "USD", bids: [] };
  for (const sb of r.seatbid || []) for (const bid of sb.bid || []) {
    const t = bid.mtype === 1 ? "banner" : bid.mtype === 2 ? "video" : bid.mtype === 4 ? "native" : mediaTypeForImp(bid.impid, internalReq.imp);
    let meta = null;
    if (bid.ext) {
      const buyer = parseInt(bid.ext.buyer_id || "0", 10) || 0, dsp = parseInt(bid.ext.dsp_id || "0", 10) || 0, brand = parseInt(bid.ext.brand_id || "0", 10) || 0;
      if (buyer > 0 || dsp > 0 || brand > 0) meta = { networkId: dsp, advertiserId: buyer, brandId: brand };
    }
    res.bids.push({ bid, type: t, video: { primary_category: (bid.cat && bid.cat[0]) || "", duration: bid.dur | 0 }, meta });
  }
  return res;
}
function run(input) { // input: string '{"req":...,"resp":"<raw body string>"}' -> string
  const { req, resp } = JSON.parse(input);
  const { reqs } = makeRequests(req);
  const br = makeBids(req, 200, resp);
  return JSON.stringify({ body: reqs[0].body, bids: br.bids, cur: br.currency });
}
