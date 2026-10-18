//! The same OpenX logic over typed, borrowing serde structs. Only the fields the Adapter reads or
//! rewrites are decoded; every other subtree is captured as a borrowed `&RawValue` and copied to
//! the output verbatim, so site/device/user/regs/source cost one scan and one memcpy.
//!
//! Research shortcut: object keys are borrowed `&str`, so a key containing a JSON escape fails to
//! parse. OpenRTB keys never need escapes; a production version would use `Cow<str>`.
use crate::{imp_type, Imps};
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, Visitor};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::borrow::Cow;
use std::fmt;

type Raw<'a> = &'a RawValue;

// ---------- MakeRequests ----------

/// Top-level request: `imp` decoded, `ext` dropped (the Adapter replaces it), the rest kept raw.
struct Req<'a> {
    rest: Vec<(&'a str, Raw<'a>)>,
    imp: Vec<Imp<'a>>,
}

#[derive(Default)]
struct Imp<'a> {
    rest: Vec<(&'a str, Raw<'a>)>,
    media: u8, // 1 banner, 2 video, 4 native
    bidfloor: Option<Raw<'a>>,
    rwdd: i64,
    video: Option<Vec<(&'a str, Raw<'a>)>>,
    ext: ImpExt<'a>,
}

#[derive(Default)]
struct ImpExt<'a> {
    rest: Vec<(&'a str, Raw<'a>)>,
    bidder: Option<OxParams<'a>>,
}

/// imp.ext.bidder for OpenX (openrtb_ext.ExtImpOpenx).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct OxParams<'a> {
    #[serde(borrow)]
    unit: Option<Raw<'a>>,
    #[serde(borrow)]
    platform: Option<Cow<'a, str>>,
    #[serde(borrow)]
    del_domain: Option<Cow<'a, str>>,
    #[serde(borrow)]
    custom_floor: Option<Raw<'a>>,
    #[serde(borrow)]
    custom_params: Option<Raw<'a>>,
}

/// Generic "object as ordered (key, raw value) list".
struct RawObj<'a>(Vec<(&'a str, Raw<'a>)>);

impl<'de> Deserialize<'de> for RawObj<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = RawObj<'de>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("object") }
            #[cfg_attr(feature = "split", inline(never))]
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Self::Value, A::Error> {
                let mut v = Vec::with_capacity(8);
                while let Some(k) = m.next_key::<&'de str>()? {
                    v.push((k, m.next_value::<Raw<'de>>()?));
                }
                Ok(RawObj(v))
            }
        }
        d.deserialize_map(V)
    }
}

impl<'de> Deserialize<'de> for Req<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Req<'de>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("BidRequest") }
            #[cfg_attr(feature = "split", inline(never))]
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Self::Value, A::Error> {
                let mut r = Req { rest: Vec::with_capacity(16), imp: Vec::new() };
                while let Some(k) = m.next_key::<&'de str>()? {
                    match k {
                        "imp" => r.imp = m.next_value()?,
                        "ext" => { m.next_value::<IgnoredAny>()?; }
                        _ => r.rest.push((k, m.next_value()?)),
                    }
                }
                Ok(r)
            }
        }
        d.deserialize_map(V)
    }
}

impl<'de> Deserialize<'de> for Imp<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Imp<'de>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("Imp") }
            #[cfg_attr(feature = "split", inline(never))]
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Self::Value, A::Error> {
                let mut imp = Imp { rest: Vec::with_capacity(12), ..Default::default() };
                while let Some(k) = m.next_key::<&'de str>()? {
                    match k {
                        "ext" => imp.ext = m.next_value()?,
                        "video" => { imp.media |= 2; imp.video = Some(m.next_value::<RawObj>()?.0); }
                        "bidfloor" => imp.bidfloor = Some(m.next_value()?),
                        "tagid" => { m.next_value::<IgnoredAny>()?; }
                        "rwdd" => { let v: Raw = m.next_value()?; imp.rwdd = v.get().parse().unwrap_or(0); imp.rest.push((k, v)); }
                        _ => {
                            if k == "banner" { imp.media |= 1 } else if k == "native" { imp.media |= 4 }
                            imp.rest.push((k, m.next_value()?));
                        }
                    }
                }
                Ok(imp)
            }
        }
        d.deserialize_map(V)
    }
}

impl<'de> Deserialize<'de> for ImpExt<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = ImpExt<'de>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("imp.ext") }
            #[cfg_attr(feature = "split", inline(never))]
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Self::Value, A::Error> {
                let mut e = ImpExt::default();
                while let Some(k) = m.next_key::<&'de str>()? {
                    match k {
                        "bidder" => e.bidder = Some(m.next_value()?),
                        "prebid" => { m.next_value::<IgnoredAny>()?; }
                        _ => e.rest.push((k, m.next_value()?)),
                    }
                }
                Ok(e)
            }
        }
        d.deserialize_map(V)
    }
}

/// Writes `"k":raw` pairs, comma-separating from whatever is already in the object.
fn put(out: &mut Vec<u8>, first: &mut bool, k: &str, v: &[u8]) {
    if !*first { out.push(b','); }
    *first = false;
    out.push(b'"');
    out.extend_from_slice(k.as_bytes());
    out.extend_from_slice(b"\":");
    out.extend_from_slice(v);
}

fn num(raw: Raw) -> f64 {
    raw.get().trim_matches('"').parse().unwrap_or(0.0)
}

/// `split` keeps the parse and the per-imp writer out of line so no compiled WASM function exceeds
/// HotSpot's 8,000-bytecode JIT limit on Endive (see ../../endive-no-flags.md).
#[cfg_attr(feature = "split", inline(never))]
fn parse_req(input: &[u8]) -> Req<'_> { serde_json::from_slice(input).unwrap() }

/// One rewritten imp object.
#[cfg_attr(feature = "split", inline(never))]
fn write_imp(out: &mut Vec<u8>, imp: &Imp, ox: &OxParams) {
    out.push(b'{');
    let mut f = true;
    for (k, v) in &imp.rest { put(out, &mut f, k, v.get().as_bytes()); }
    // tagid = unit as a string (json.Number.String()).
    match ox.unit {
        Some(u) if u.get().starts_with('"') => put(out, &mut f, "tagid", u.get().as_bytes()),
        Some(u) => { put(out, &mut f, "tagid", b"\""); out.extend_from_slice(u.get().as_bytes()); out.push(b'"'); }
        None => put(out, &mut f, "tagid", b"\"\""),
    }
    let floor = imp.bidfloor.map_or(0.0, num);
    let custom = ox.custom_floor.map_or(0.0, num);
    if floor == 0.0 && custom > 0.0 {
        put(out, &mut f, "bidfloor", b"");
        serde_json::to_writer(&mut *out, &custom).unwrap();
    } else if let Some(b) = imp.bidfloor.filter(|_| floor != 0.0) {
        put(out, &mut f, "bidfloor", b.get().as_bytes());
    }
    if !imp.ext.rest.is_empty() || ox.custom_params.is_some() {
        put(out, &mut f, "ext", b"{");
        let mut fe = true;
        for (k, v) in &imp.ext.rest {
            if *k != "customParams" || ox.custom_params.is_none() { put(out, &mut fe, k, v.get().as_bytes()); }
        }
        if let Some(cp) = ox.custom_params { put(out, &mut fe, "customParams", cp.get().as_bytes()); }
        out.push(b'}');
    }
    if let Some(video) = &imp.video {
        put(out, &mut f, "video", b"{");
        let mut fv = true;
        for (k, v) in video { if *k != "ext" { put(out, &mut fv, k, v.get().as_bytes()); } }
        if imp.rwdd == 1 { put(out, &mut fv, "ext", br#"{"rewarded":1}"#); }
        out.push(b'}');
    }
    out.push(b'}');
}

pub fn make_requests(input: &[u8], out: &mut Vec<u8>) {
    let req = parse_req(input);
    let (mut del_domain, mut platform): (Option<Cow<str>>, Option<Cow<str>>) = (None, None);
    out.push(b'{');
    let mut first = true;
    for (k, v) in &req.rest { put(out, &mut first, k, v.get().as_bytes()); }
    put(out, &mut first, "imp", b"[");
    let mut first_imp = true;
    for imp in &req.imp {
        if imp.media == 0 { continue; }
        let Some(ox) = &imp.ext.bidder else { continue };
        del_domain = ox.del_domain.clone();
        platform = ox.platform.clone();
        if !first_imp { out.push(b','); }
        first_imp = false;
        write_imp(out, imp, ox);
    }
    out.push(b']');
    put(out, &mut first, "ext", b"{");
    let mut fe = true;
    for (k, v) in [("delDomain", &del_domain), ("platform", &platform)] {
        if let Some(s) = v.as_deref().filter(|s| !s.is_empty()) {
            put(out, &mut fe, k, b"");
            serde_json::to_writer(&mut *out, s).unwrap();
        }
    }
    put(out, &mut fe, "bc", b"\"hb_pbs_1.0.0\"");
    out.extend_from_slice(b"}}");
}

// ---------- MakeBids ----------

#[derive(Deserialize)]
struct Resp<'a> {
    #[serde(borrow, default)]
    seatbid: Vec<Seat<'a>>,
    #[serde(borrow)]
    cur: Option<Cow<'a, str>>,
}

#[derive(Deserialize)]
struct Seat<'a> {
    #[serde(borrow, default)]
    bid: Vec<Bid<'a>>,
}

/// Only what OpenX's MakeBids reads; `adm` and everything else is skipped by serde.
#[derive(Deserialize)]
struct Bid<'a> {
    #[serde(borrow, default)]
    impid: Cow<'a, str>,
    mtype: Option<i64>,
    #[serde(borrow, default)]
    cat: Option<FirstStr<'a>>,
    dur: Option<i64>,
    #[serde(borrow)]
    ext: Option<BidExt<'a>>,
}

#[derive(Deserialize)]
struct BidExt<'a> {
    #[serde(borrow)]
    dsp_id: Option<Cow<'a, str>>,
    #[serde(borrow)]
    brand_id: Option<Cow<'a, str>>,
    #[serde(borrow)]
    buyer_id: Option<Cow<'a, str>>,
}

/// `cat[0]` without allocating a Vec.
struct FirstStr<'a>(Option<Cow<'a, str>>);
impl<'de: 'a, 'a> Deserialize<'de> for FirstStr<'a> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<'a>(std::marker::PhantomData<&'a ()>);
        impl<'de: 'a, 'a> Visitor<'de> for V<'a> {
            type Value = FirstStr<'a>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("array") }
            #[cfg_attr(feature = "split", inline(never))]
            fn visit_seq<A: de::SeqAccess<'de>>(self, mut s: A) -> Result<Self::Value, A::Error> {
                let first = s.next_element()?;
                while s.next_element::<IgnoredAny>()?.is_some() {}
                Ok(FirstStr(first))
            }
        }
        d.deserialize_seq(V(std::marker::PhantomData))
    }
}

struct Annot<'a> {
    typ: &'static str,
    cat: &'a str,
    dur: i64,
    meta: Option<(i64, i64, i64)>, // networkId, advertiserId, brandId
}

fn annotate<'a>(b: &'a Bid<'a>, imps: &Imps) -> Annot<'a> {
    let p = |s: &Option<Cow<str>>| s.as_deref().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    let meta = b.ext.as_ref().map(|e| (p(&e.dsp_id), p(&e.buyer_id), p(&e.brand_id)))
        .filter(|&(d, bu, br)| d > 0 || bu > 0 || br > 0);
    Annot {
        typ: imp_type(b.mtype, &b.impid, imps),
        cat: b.cat.as_ref().and_then(|c| c.0.as_deref()).unwrap_or(""),
        dur: b.dur.unwrap_or(0),
        meta,
    }
}

/// Lean MakeBids: the Host parses the response itself (as the Hand-written Adapter would) and the
/// guest returns only per-bid annotations, in bid order, as a little-endian binary record:
/// u32 n, then per bid: u8 type (0 banner, 1 video, 2 native), i64 dur, u16 len + cat bytes,
/// u8 has_meta, i64 networkId, i64 advertiserId, i64 brandId; then u16 len + cur.
pub fn make_bids_annot(imps: &Imps, resp: &[u8], out: &mut Vec<u8>) {
    let r: Resp = serde_json::from_slice(resp).unwrap();
    let n: usize = r.seatbid.iter().map(|s| s.bid.len()).sum();
    out.extend_from_slice(&(n as u32).to_le_bytes());
    for b in r.seatbid.iter().flat_map(|s| &s.bid) {
        let a = annotate(b, imps);
        out.push(match a.typ { "video" => 1, "native" => 2, _ => 0 });
        out.extend_from_slice(&a.dur.to_le_bytes());
        out.extend_from_slice(&(a.cat.len() as u16).to_le_bytes());
        out.extend_from_slice(a.cat.as_bytes());
        let (m, (d, bu, br)) = a.meta.map_or((0u8, (0, 0, 0)), |m| (1, m));
        out.push(m);
        for v in [d, bu, br] { out.extend_from_slice(&v.to_le_bytes()); }
    }
    let cur = r.cur.as_deref().filter(|c| !c.is_empty()).unwrap_or("USD");
    out.extend_from_slice(&(cur.len() as u16).to_le_bytes());
    out.extend_from_slice(cur.as_bytes());
}

#[derive(Deserialize)]
struct RespRaw<'a> {
    #[serde(borrow, default)]
    seatbid: Vec<SeatRaw<'a>>,
    #[serde(borrow)]
    cur: Option<Cow<'a, str>>,
}
#[derive(Deserialize)]
struct SeatRaw<'a> {
    #[serde(borrow, default)]
    bid: Vec<Raw<'a>>,
}

/// Typed MakeBids with the same JSON output as the Value guest: each bid is passed through as raw
/// JSON (no re-serialization), but the Host must then parse the whole output again.
pub fn make_bids_json(imps: &Imps, resp: &[u8], out: &mut Vec<u8>) {
    let r: RespRaw = serde_json::from_slice(resp).unwrap();
    out.extend_from_slice(b"{\"bids\":[");
    let mut first = true;
    for raw in r.seatbid.iter().flat_map(|s| &s.bid) {
        let b: Bid = serde_json::from_str(raw.get()).unwrap();
        let a = annotate(&b, imps);
        if !first { out.push(b','); }
        first = false;
        out.extend_from_slice(b"{\"bid\":");
        out.extend_from_slice(raw.get().as_bytes());
        out.extend_from_slice(b",\"type\":\"");
        out.extend_from_slice(a.typ.as_bytes());
        out.extend_from_slice(b"\",\"video\":{\"primary_category\":");
        serde_json::to_writer(&mut *out, a.cat).unwrap();
        out.extend_from_slice(b",\"duration\":");
        out.extend_from_slice(a.dur.to_string().as_bytes());
        out.extend_from_slice(b"},\"meta\":");
        match a.meta {
            Some((d, bu, br)) => out.extend_from_slice(format!(r#"{{"networkId":{d},"advertiserId":{bu},"brandId":{br}}}"#).as_bytes()),
            None => out.extend_from_slice(b"null"),
        }
        out.push(b'}');
    }
    out.extend_from_slice(b"],\"cur\":");
    serde_json::to_writer(&mut *out, r.cur.as_deref().filter(|c| !c.is_empty()).unwrap_or("USD")).unwrap();
    out.push(b'}');
}
