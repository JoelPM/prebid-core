//! OpenX Shared Adapter logic, ORTB -> ORTB.
//!
//! Server profile mirrors prebid-server/adapters/openx/openx.go (MakeRequests/MakeBids).
//! Client profile adds what modules/openxBidAdapter.js layers on top of ortbConverter
//! (bc/at/dnt/coppa/test/response_template_name, divid, params.video merge, isBidRequestValid).
//! The Host has already built the generic ORTB request (PBS core / ortbConverter) and put
//! each bid's params in imp.ext.bidder.
use crate::{Doc, Kind};

pub fn make_requests<D: Doc>(d: &mut D, req: D::V, client: bool) -> D::V {
    let out = d.obj();
    let errs = d.arr();
    let imps = d.get(req, "imp");
    let valid = d.arr();
    let mut del_domain = d.lit("");
    let mut platform = d.lit("");
    let mut first = d.obj();
    let mut seen = false;

    for i in 0..d.len(imps) {
        let imp = d.at(imps, i);
        if !(d.has(imp, "banner") || d.has(imp, "video") || d.has(imp, "native")) {
            continue;
        }
        let ext = d.get(imp, "ext");
        let p = d.get(ext, "bidder");
        if d.kind(p) != Kind::Obj {
            let e = d.lit("imp.ext.bidder: expected an object");
            d.push(errs, e);
            continue;
        }
        if !seen {
            first = p;
            seen = true;
        }
        // Go overwrites with every imp, so the last one wins
        del_domain = d.get(p, "delDomain");
        platform = d.get(p, "platform");

        let unit = d.get(p, "unit");
        let tag = d.to_str(unit);
        if d.truthy(tag) {
            d.set(imp, "tagid", tag);
        }
        let floor = d.get(imp, "bidfloor");
        if !d.pos_num(floor) {
            let cf = d.get(p, "customFloor");
            if d.pos_num(cf) {
                let n = d.to_num(cf);
                d.set(imp, "bidfloor", n);
            }
        }

        // outgoing imp.ext = incoming imp.ext minus prebid/bidder, plus customParams
        let x = d.clone_obj(ext);
        d.del(x, "prebid");
        d.del(x, "bidder");
        let cp = d.get(p, "customParams");
        if d.kind(cp) == Kind::Obj {
            d.set(x, "customParams", cp);
        }
        if client {
            let code = d.get2(ext, "prebid", "adunitcode");
            if d.truthy(code) {
                d.set(x, "divid", code);
            }
        }
        if d.len(x) > 0 {
            d.set(imp, "ext", x);
        } else {
            d.del(imp, "ext");
        }

        let video = d.get(imp, "video");
        if d.kind(video) == Kind::Obj {
            let v = d.clone_obj(video);
            if client {
                // params.video overrides mediaTypes.video (openxBidAdapter.js `video` override)
                let pv = d.get(p, "video");
                for j in 0..d.len(pv) {
                    let k = d.key_at(pv, j);
                    let val = d.at(pv, j);
                    d.set_dyn(v, k, val);
                }
            } else {
                let rwdd = d.get(imp, "rwdd");
                if d.str_eq(rwdd, "1") {
                    let r = d.obj();
                    let one = d.int(1);
                    d.set(r, "rewarded", one);
                    d.set(v, "ext", r);
                } else {
                    d.del(v, "ext");
                }
            }
            d.set(imp, "video", v);
        }
        d.push(valid, imp);
    }

    if d.len(valid) > 0 {
        d.set(req, "imp", valid);
        let ext = if client { { let e = d.get(req, "ext"); d.clone_obj(e) } } else { d.obj() };
        if client {
            del_domain = d.get(first, "delDomain");
            platform = d.get(first, "platform");
            let bc = d.lit("hb_pb_ortb_2.0");
            d.set(ext, "bc", bc);
            let one = d.int(1);
            d.set(req, "at", one);
            let dev = d.get(req, "device");
            let dev = d.clone_obj(dev);
            let zero = d.int(0);
            d.set(dev, "dnt", zero);
            d.set(req, "device", dev);
            let coppa = d.get(first, "coppa");
            if d.truthy(coppa) {
                let regs = d.get(req, "regs");
                let regs = d.clone_obj(regs);
                d.set(regs, "coppa", one);
                d.set(req, "regs", regs);
            }
            let rt = d.get(first, "response_template_name");
            if d.truthy(rt) {
                d.set(ext, "response_template_name", rt);
            }
            let test = d.get(first, "test");
            if d.truthy(test) {
                d.set(req, "test", one);
            }
        } else {
            let bc = d.lit("hb_pbs_1.0.0");
            d.set(ext, "bc", bc);
        }
        if d.truthy(del_domain) {
            d.set(ext, "delDomain", del_domain);
        }
        if d.truthy(platform) {
            d.set(ext, "platform", platform);
        }
        d.set(req, "ext", ext);
        d.set(out, "request", req);
    }
    if d.len(errs) > 0 {
        d.set(out, "errors", errs);
    }
    out
}

/// Prebid.js isBidRequestValid, on a Prebid.js bidRequest ({params, mediaTypes}).
pub fn is_valid<D: Doc>(d: &mut D, bid: D::V) -> bool {
    let p = d.get(bid, "params");
    let dd = d.get(p, "delDomain");
    let pl = d.get(p, "platform");
    let has_dd = d.truthy(dd) || d.truthy(pl);
    let unit = d.get(p, "unit");
    let unit = d.truthy(unit);
    let banner = d.get2(bid, "mediaTypes", "banner");
    if d.truthy(banner) && has_dd {
        let sizes = d.get(banner, "sizes");
        return unit || d.len(sizes) > 0;
    }
    unit && has_dd
}

/// PBS-Go MakeBids (status-code handling left to the Host).
/// Returns {currency, bids:[{bid,type,video,meta?}], fledgeauctionconfigs?}.
pub fn make_bids<D: Doc>(d: &mut D, req: D::V, resp: D::V) -> D::V {
    let out = d.obj();
    let cur = d.get(resp, "cur");
    let cur = if d.truthy(cur) { cur } else { d.lit("USD") };
    d.set(out, "currency", cur);

    let fac = d.get2(resp, "ext", "fledge_auction_configs");
    if d.kind(fac) == Kind::Obj {
        let list = d.arr();
        for i in 0..d.len(fac) {
            let c = d.obj();
            let k = d.key_at(fac, i);
            d.set(c, "impid", k);
            let b = d.lit("openx");
            d.set(c, "bidder", b);
            let cfg = d.at(fac, i);
            d.set(c, "config", cfg);
            d.push(list, c);
        }
        d.set(out, "fledgeauctionconfigs", list);
    }

    let bids = d.arr();
    let imps = d.get(req, "imp");
    let sbs = d.get(resp, "seatbid");
    for i in 0..d.len(sbs) {
        let sb = d.at(sbs, i);
        let sb = d.get(sb, "bid");
        for j in 0..d.len(sb) {
            let bid = d.at(sb, j);
            let tb = d.obj();
            d.set(tb, "bid", bid);
            let ty = bid_type(d, bid, imps);
            let ty = d.lit(ty);
            d.set(tb, "type", ty);

            let video = d.obj();
            let cat = d.get(bid, "cat");
            let cat = d.at(cat, 0);
            let cat = if d.kind(cat) == Kind::Str { cat } else { d.lit("") };
            d.set(video, "primary_category", cat);
            let dur = d.get(bid, "dur");
            let dur = if d.kind(dur) == Kind::Num { dur } else { d.int(0) };
            d.set(video, "duration", dur);
            d.set(tb, "video", video);

            let x = d.get(bid, "ext");
            let net = id(d, x, "dsp_id");
            let adv = id(d, x, "buyer_id");
            let brand = id(d, x, "brand_id");
            if net.is_some() || adv.is_some() || brand.is_some() {
                let m = d.obj();
                for (k, v) in [("networkId", net), ("advertiserId", adv), ("brandId", brand)] {
                    let v = match v { Some(v) => v, None => d.int(0) };
                    d.set(m, k, v);
                }
                d.set(tb, "meta", m);
            }
            d.push(bids, tb);
        }
    }
    d.set(out, "bids", bids);
    out
}

/// positive integer id, given as number or numeric string (Go `json:",string"` / Atoi)
fn id<D: Doc>(d: &mut D, x: D::V, k: &'static str) -> Option<D::V> {
    let v = d.get(x, k);
    if d.pos_num(v) { Some(d.to_num(v)) } else { None }
}

fn bid_type<D: Doc>(d: &mut D, bid: D::V, imps: D::V) -> &'static str {
    let mt = d.get(bid, "mtype");
    if d.str_eq(mt, "1") {
        return "banner";
    }
    if d.str_eq(mt, "2") {
        return "video";
    }
    if d.str_eq(mt, "4") {
        return "native";
    }
    // fallback: media type of the matching imp; banner wins
    let impid = d.get(bid, "impid");
    for i in 0..d.len(imps) {
        let imp = d.at(imps, i);
        let iid = d.get(imp, "id");
        if d.same_str(iid, impid) {
            if !d.has(imp, "banner") {
                if d.has(imp, "video") {
                    return "video";
                }
                if d.has(imp, "native") {
                    return "native";
                }
            }
            break;
        }
    }
    "banner"
}
