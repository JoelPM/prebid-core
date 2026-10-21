//! OpenX (defs/openx.yaml, core + Server Extension), hand-written in the shape a typed back end
//! would emit. Same patterns as pubmatic.rs; OpenX has no string pipelines, so what it exercises is
//! the typed decode, streaming pass-through and the lazy imp lookup in MakeBids.
use crate::j::{self, Raw, P, W};
use crate::Fr;

pub const BIDDER: &str = "openx";

/// imp.ext.bidder, typed from defs/openx.params.json (`unit` and `customFloor` are number|string).
#[derive(Default, Clone, Copy)]
struct Params<'a> {
    unit: Option<Raw<'a>>,
    custom_floor: Option<Raw<'a>>,
    custom_params: Option<Raw<'a>>,
    del_domain: Option<Raw<'a>>,
    platform: Option<Raw<'a>>,
}

fn params<'a>(p: &mut P<'a>) -> Params<'a> {
    let mut x = Params::default();
    p.obj(|p, k| match &*j::key(k) {
        b"unit" => x.unit = Some(p.raw()),
        b"customFloor" => x.custom_floor = Some(p.raw()),
        b"customParams" => x.custom_params = Some(p.raw()),
        b"delDomain" => x.del_domain = Some(p.raw()),
        b"platform" => x.platform = Some(p.raw()),
        _ => p.ignore(),
    });
    x
}

pub fn make_requests(input: &[u8], out: &mut Vec<u8>) {
    out.u32(1);
    let body_at = out.begin();
    let mut ids: Vec<u8> = Vec::with_capacity(64);
    let ids_n = ids.begin();
    let mut n_ids = 0;
    let mut errs: Vec<String> = Vec::new();
    let mut first: Option<Params> = None;
    let mut all: Vec<Params> = Vec::new(); // abl_unfused: the materialized `params` list

    let mut w = W { b: &mut *out };
    w.open(b'{');
    // Nothing at the top level depends on a later member, so the request streams in one pass.
    P::new(input).obj(|p, k| match &*j::key(k) {
        b"imp" => {
            key!(w, "imp");
            w.open(b'[');
            p.arr(|p| {
                if let Some((x, id)) = j::with(p, |p| one_imp(p, &mut w, &mut errs)) {
                    ids.bytes(id.as_bytes());
                    n_ids += 1;
                    if cfg!(feature = "abl_unfused") {
                        all.push(x);
                    } else if first.is_none() {
                        first = Some(x);
                    }
                }
            });
            w.close(b']');
        }
        b"ext" => {
            p.raw(); // replaced
        }
        _ => {
            let v = p.raw();
            w.member(k, v)
        }
    });
    if cfg!(feature = "abl_unfused") {
        first = all.first().copied();
    }
    if n_ids == 0 {
        out.clear();
        out.u32(0);
    } else {
        // ext: {delDomain: params[0].delDomain, platform: params[0].platform}; Server Extension: ext.bc
        let x = first.unwrap_or_default();
        key!(w, "ext");
        w.open(b'{');
        if let Some(v) = x.del_domain {
            key!(w, "delDomain");
            w.raw(v);
        }
        if let Some(v) = x.platform {
            key!(w, "platform");
            w.raw(v);
        }
        key!(w, "bc");
        w.str_(&crate::lit!("hb_pbs_1.0.0"));
        w.close(b'}');
        w.close(b'}');
        out.end(body_at);
    }
    ids.patch(ids_n, n_ids);
    out.extend_from_slice(&ids);
    out.u32(errs.len() as u32);
    errs.iter().for_each(|e| out.bytes(e.as_bytes()));
}

fn one_imp<'a>(p: &mut P<'a>, w: &mut W, errs: &mut Vec<String>) -> Option<(Params<'a>, j::S<'a>)> {
    let mark = w.mark();
    w.elem();
    w.open(b'{');
    let (mut id, mut banner, mut video, mut native, mut rwdd, mut bidfloor) = (None, None, None, None, None, None);
    let mut x = Params::default();
    p.obj(|p, k| match &*j::key(k) {
        b"tagid" => p.ignore(),
        b"bidfloor" => bidfloor = Some(p.raw()),
        b"video" => video = Some(p.raw()),
        b"ext" => {
            // ext: nonempty(merge(without(imp.ext, 'prebid', 'bidder'), {customParams: p.customParams}))
            let mark = w.mark();
            key!(w, "ext");
            let body = w.open(b'{');
            let mut own_cp = None;
            p.obj(|p, k| match &*j::key(k) {
                b"bidder" => x = params(p),
                b"prebid" => p.ignore(),
                b"customParams" => own_cp = Some(p.raw()),
                _ => {
                    let v = p.raw();
                    w.member(k, v)
                }
            });
            if let Some(v) = x.custom_params.or(own_cp) {
                key!(w, "customParams");
                w.raw(v);
            }
            w.close_nonempty(mark, body);
        }
        kk => {
            let v = p.raw();
            match kk {
                b"id" => id = Some(v),
                b"banner" => banner = Some(v),
                b"native" => native = Some(v),
                b"rwdd" => rwdd = Some(v),
                _ => {}
            }
            w.member(k, v)
        }
    });
    if !(j::truthy(banner) || j::truthy(video) || j::truthy(native)) {
        w.b.truncate(mark);
        errs.push(format!("OpenX only supports banner, video and native imps; ignoring imp {}", id.and_then(j::scalar).unwrap_or_default()));
        return None;
    }
    // tagid: str(p.unit)
    if let Some(u) = x.unit {
        if u.first() == Some(&b'"') {
            key!(w, "tagid");
            w.raw(u);
        } else if let Some(s) = j::scalar(u) {
            key!(w, "tagid");
            w.str_(&s);
        }
    }
    // bidfloor: !imp.bidfloor && num(p.customFloor) > 0 ? num(p.customFloor) : keep
    let cf = x.custom_floor.and_then(|r| match r.first() {
        Some(b'"') => j::jstr(r).and_then(|s| j::num_str(&s.cow())).map(|f| (f, None)),
        _ => j::num(r).map(|f| (f, Some(r))),
    });
    match cf {
        Some((f, raw)) if !j::truthy(bidfloor) && f > 0.0 => {
            key!(w, "bidfloor");
            match raw {
                Some(r) => w.raw(r),
                None => w.num(f),
            }
        }
        _ => {
            if let Some(v) = bidfloor {
                key!(w, "bidfloor");
                w.raw(v);
            }
        }
    }
    // video?.ext: imp.rwdd == 1 ? {rewarded: 1} : ~
    if let Some(v) = video {
        key!(w, "video");
        let rewarded = rwdd.and_then(j::num) == Some(1.0);
        if j::is_null(v) || (v.first() != Some(&b'{') && !rewarded) {
            w.raw(v);
        } else {
            w.open(b'{');
            P::new(v).obj(|p, k| {
                let r = p.raw();
                if &*j::key(k) != b"ext" {
                    w.member(k, r);
                }
            });
            if rewarded {
                key!(w, "ext");
                w.b.extend_from_slice(b"{\"rewarded\":1}");
            }
            w.close(b'}');
        }
    }
    w.close(b'}');
    let id = id.and_then(j::jstr).map(|s| s.cow()).unwrap_or_default();
    Some((x, id))
}

// ---------- MakeBids ----------

#[derive(Default)]
struct Bid<'a> {
    impid: Option<Raw<'a>>,
    mtype: Option<Raw<'a>>,
    cat: Option<Raw<'a>>,
    dur: Option<Raw<'a>>,
    dsp_id: Option<Raw<'a>>,
    buyer_id: Option<Raw<'a>>,
    brand_id: Option<Raw<'a>>,
}
fn bid<'a>(p: &mut P<'a>) -> Bid<'a> {
    let mut b = Bid::default();
    p.obj(|p, k| match &*j::key(k) {
        b"impid" => b.impid = Some(p.raw()),
        b"mtype" => b.mtype = Some(p.raw()),
        b"cat" => b.cat = Some(p.raw()),
        b"dur" => b.dur = Some(p.raw()),
        b"ext" => {
            (b.dsp_id, b.buyer_id, b.brand_id) = (None, None, None);
            p.obj(|p, k| match &*j::key(k) {
                b"dsp_id" => b.dsp_id = Some(p.raw()),
                b"buyer_id" => b.buyer_id = Some(p.raw()),
                b"brand_id" => b.brand_id = Some(p.raw()),
                _ => p.ignore(),
            });
        }
        _ => p.ignore(),
    });
    b
}

/// The request's imps as the bid phase reads them: id and which media they offer. Decoded only
/// when a bid's mtype doesn't settle its type (`imp` is lazy in the Definition).
struct Imp<'a> {
    id: Option<j::JStr<'a>>,
    media: [bool; 3],
}
fn imps(req: &[u8]) -> Vec<Imp<'_>> {
    let mut out = Vec::new();
    P::new(req).obj(|p, k| {
        if &*j::key(k) != b"imp" {
            p.raw();
            return;
        }
        out.clear();
        p.arr(|p| {
            let mut i = Imp { id: None, media: [false; 3] };
            p.obj(|p, k| {
                let v = p.raw();
                match &*j::key(k) {
                    b"id" => i.id = j::jstr(v),
                    b"banner" => i.media[0] = j::truthy(Some(v)),
                    b"video" => i.media[1] = j::truthy(Some(v)),
                    b"native" => i.media[2] = j::truthy(Some(v)),
                    _ => {}
                }
            });
            out.push(i);
        });
    });
    out
}

fn bid_type<'r>(b: &Bid, req: &'r [u8], cache: &mut Option<Vec<Imp<'r>>>) -> &'static str {
    let k = b.mtype.and_then(|m| match m.first() {
        Some(b'"') => match j::jstr(m)?.0 {
            b"1" => Some(1.0),
            b"2" => Some(2.0),
            b"4" => Some(4.0),
            _ => None,
        },
        _ => j::num(m),
    });
    match k {
        Some(1.0) => return "banner",
        Some(2.0) => return "video",
        Some(4.0) => return "native",
        _ => {}
    }
    let imps = cache.get_or_insert_with(|| imps(req));
    let id = b.impid.and_then(j::jstr).map(|s| s.cow());
    let imp = id.and_then(|id| imps.iter().find(|i| i.id.map_or(false, |x| x.cow() == id)));
    match imp.map(|i| i.media) {
        Some([true, _, _]) => "banner",
        Some([_, true, _]) => "video",
        Some([_, _, true]) => "native",
        _ => "banner",
    }
}

/// int(x) > 0 ? int(x) : ~, as key/value number text.
fn pos_int(r: Option<Raw>) -> Option<(f64, Option<Raw>)> {
    let r = r?;
    let (f, raw) = match r.first()? {
        b'"' => (j::int_str(&j::jstr(r)?.cow())?, None),
        b'-' | b'0'..=b'9' => {
            let f = j::num(r)?;
            if !(f.is_finite() && f.fract() == 0.0) {
                return None;
            }
            (f, Some(r))
        }
        _ => return None,
    };
    (f > 0.0).then_some((f, raw))
}

fn one_bid<'r>(p: &mut P, req: &'r [u8], cache: &mut Option<Vec<Imp<'r>>>, out: &mut Vec<u8>) {
    let b = bid(p);
    let typ = bid_type(&b, req, cache);
    out.u32(1);
    out.bytes(typ.as_bytes());
    out.u32(0); // seat
    out.u32(0); // deal priority
    // video: {primary_category: bid.cat[0], duration: bid.dur}
    let cat0 = j::nth(b.cat, 0);
    let slot = crate::kv_begin(out);
    let mut n = 0;
    for (k, v) in [("primary_category", cat0), ("duration", b.dur)] {
        if let Some(v) = v {
            match v.first() {
                Some(b'"') => crate::kv_member(out, k, 0, j::jstr(v).unwrap().cow().as_bytes()),
                Some(b'-' | b'0'..=b'9') => crate::kv_member(out, k, 1, v),
                _ => crate::kv_member(out, k, 2, v),
            }
            n += 1;
        }
    }
    crate::kv_end(out, slot, n);
    // meta: nonempty({networkId, advertiserId, brandId})
    let slot = crate::kv_begin(out);
    let mut n = 0;
    for (k, v) in [("networkId", b.dsp_id), ("advertiserId", b.buyer_id), ("brandId", b.brand_id)] {
        if let Some((f, raw)) = pos_int(v) {
            match raw {
                Some(r) => crate::kv_member(out, k, 1, r),
                None => {
                    let mut s = Vec::new();
                    W { b: &mut s }.num(f);
                    crate::kv_member(out, k, 1, &s);
                }
            }
            n += 1;
        }
    }
    crate::kv_end(out, slot, n);
    out.u32(0); // no overrides
}

pub fn make_bids(req: &[u8], resp: &[u8], out: &mut Vec<u8>) {
    let mut cache = if cfg!(feature = "abl_eager") { Some(imps(req)) } else { None };
    let n_at = out.begin();
    let mut n = 0;
    let (mut cur, mut rext) = (None, None);
    P::new(resp).obj(|p, k| match &*j::key(k) {
        b"seatbid" => {
            p.arr(|p| {
                p.obj(|p, k| {
                    if &*j::key(k) == b"bid" {
                        p.arr(|p| {
                            j::with(p, |p| one_bid(p, req, &mut cache, out));
                            n += 1;
                        });
                    } else {
                        p.raw();
                    }
                });
            });
        }
        b"cur" => cur = Some(p.raw()),
        b"ext" => rext = Some(p.raw()),
        _ => p.ignore(),
    });
    out.patch(n_at, n);
    let cur = cur.and_then(j::jstr).map(|s| s.cow()).unwrap_or_default();
    out.bytes(cur.as_bytes());
    crate::paapi(out, j::get(rext, "fledge_auction_configs"));
    out.u32(0); // errors
}
