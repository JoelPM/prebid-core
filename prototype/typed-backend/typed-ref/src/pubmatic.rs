//! PubMatic (defs/pubmatic.yaml), hand-written in the shape a typed back end would emit:
//! - decoders typed from OpenRTB and defs/pubmatic.params.json that read only the fields some rule
//!   reads; every other member is copied to the output as it streams by;
//! - string expressions as `&str` views (`S`), allocating only when an operation must build one;
//! - `filter`/`map`/`fromEntries`/`join` pipelines fused into one loop with no intermediate list;
//! - output keys and literals baked in as bytes; loop-invariant request reads hoisted out of the imp loop.
//! `abl_*` features revert one pattern each (Cargo.toml).
use crate::j::{self, JStr, Raw, S, P, W};
use crate::Fr;
use std::borrow::Cow;

pub const BIDDER: &str = "pubmatic";

/// imp.ext.bidder, typed from defs/pubmatic.params.json. Fields the Definition reads through
/// `str()` stay raw and are coerced at use (any scalar); `pmzoneid`/`dctr` are schema strings.
/// `keywords` is read by exactly one pipeline, which runs inside the decoder (`kw` below); only
/// `abl_unfused` keeps it as a span for a separate, materializing pass.
#[derive(Default, Clone, Copy)]
struct Params<'a> {
    publisher_id: Option<Raw<'a>>,
    ad_slot: Option<Raw<'a>>,
    kadfloor: Option<Raw<'a>>,
    pmzoneid: Option<JStr<'a>>,
    dctr: Option<JStr<'a>>,
    keywords: Option<Raw<'a>>,
    profile: Option<Raw<'a>>,
    version: Option<Raw<'a>>,
}

fn params<'a>(p: &mut P<'a>, kw: &mut Kw<'a>) -> Params<'a> {
    let mut x = Params::default();
    p.obj(|p, k| match &*j::key(k) {
        b"publisherId" => x.publisher_id = Some(p.raw()),
        b"adSlot" => x.ad_slot = Some(p.raw()),
        b"kadfloor" => x.kadfloor = Some(p.raw()),
        b"pmzoneid" => x.pmzoneid = p.str(),
        b"dctr" => x.dctr = p.str(),
        b"keywords" if cfg!(feature = "abl_unfused") => x.keywords = Some(p.raw()),
        b"keywords" => *kw = keywords_in(p),
        b"wrapper" => {
            (x.profile, x.version) = (None, None);
            p.obj(|p, k| match &*j::key(k) {
                b"profile" => x.profile = Some(p.raw()),
                b"version" => x.version = Some(p.raw()),
                _ => p.ignore(),
            });
        }
        _ => p.ignore(),
    });
    x
}

/// imp.ext: replaced wholesale by the Definition, so only what it reads is kept.
#[derive(Default)]
struct ImpExt<'a> {
    bidder: Params<'a>,
    kw: Kw<'a>,
    data: Option<Raw<'a>>,
    ae: Option<Raw<'a>>,
    gpid: Option<Raw<'a>>,
    skadn: Option<Raw<'a>>,
}

fn imp_ext<'a>(p: &mut P<'a>) -> ImpExt<'a> {
    let mut x = ImpExt::default();
    p.obj(|p, k| match &*j::key(k) {
        b"bidder" => {
            x.kw.clear();
            x.bidder = params(p, &mut x.kw)
        }
        b"data" => x.data = Some(p.raw()),
        b"ae" => x.ae = Some(p.raw()),
        b"gpid" => x.gpid = Some(p.raw()),
        b"skadn" => x.skadn = Some(p.raw()),
        _ => p.ignore(),
    });
    x
}

/// `dm`: req.app.ext.prebid when it has source and version, else req.app.ext when it does.
#[derive(Clone, Copy)]
struct Dm<'a> {
    source: Option<Raw<'a>>,
    version: Option<Raw<'a>>,
}
fn dm<'a>(app: Option<Raw<'a>>) -> Option<Dm<'a>> {
    let ext = j::get(app, "ext");
    for o in [j::get(ext, "prebid"), ext] {
        let (source, version) = (j::get(o, "source"), j::get(o, "version"));
        if j::truthy(source) && j::truthy(version) {
            return Some(Dm { source, version });
        }
    }
    None
}

/// What the request phase folds over the accepted imps' params (`first(params.map(...))`).
#[derive(Default)]
struct Fold<'a> {
    publisher: Option<S<'a>>,
    profile: Option<Raw<'a>>,
    version: Option<Raw<'a>>,
    all: Vec<Params<'a>>, // abl_unfused only: the materialized `params` list
}
impl<'a> Fold<'a> {
    fn add(&mut self, x: Params<'a>) {
        if cfg!(feature = "abl_unfused") {
            return self.all.push(x);
        }
        if self.publisher.is_none() {
            self.publisher = x.publisher_id.and_then(j::scalar).map(|s| j::trim(&s)).filter(|s| !s.is_empty());
        }
        if self.profile.is_none() && j::truthy(x.profile) {
            self.profile = x.profile;
        }
        if self.version.is_none() && j::truthy(x.version) {
            self.version = x.version;
        }
    }
    fn finish(&mut self) {
        if !cfg!(feature = "abl_unfused") {
            return;
        }
        let pubs: Vec<S<'a>> = self.all.iter().filter_map(|x| x.publisher_id.and_then(j::scalar).map(|s| j::trim(&s))).collect();
        self.publisher = pubs.into_iter().find(|s| !s.is_empty());
        let profiles: Vec<Raw<'a>> = self.all.iter().filter_map(|x| x.profile).collect();
        self.profile = profiles.into_iter().find(|r| j::truthy(Some(r)));
        let versions: Vec<Raw<'a>> = self.all.iter().filter_map(|x| x.version).collect();
        self.version = versions.into_iter().find(|r| j::truthy(Some(r)));
    }
}

/// What the imp loop builds, kept apart from the body so a speculative pass can be redone.
#[derive(Default)]
struct Imps<'a> {
    buf: Vec<u8>, // "[imp,imp,..." without the closing bracket
    ids: Vec<u8>,
    n: u32,
    errs: Vec<String>,
    fold: Fold<'a>,
}

fn run_imps<'a>(p: &mut P<'a>, app: Option<Raw<'a>>, st: &mut Imps<'a>) {
    let Imps { buf, ids, n, errs, fold } = st;
    buf.clear();
    buf.push(b'[');
    ids.clear();
    ids.u32(0);
    *n = 0;
    errs.clear();
    *fold = Fold::default();
    let hoisted = dm(app);
    let mut w = W { b: buf };
    p.arr(|p| {
        let dm = if cfg!(feature = "abl_nohoist") { dm(app) } else { hoisted };
        if let Some((params, id)) = j::with(p, |p| one_imp(p, &mut w, dm, errs)) {
            ids.bytes(id.as_bytes());
            *n += 1;
            fold.add(params);
        }
    });
    ids.patch(0, *n);
    fold.finish();
}

pub fn make_requests(input: &[u8], out: &mut Vec<u8>) {
    out.u32(1);
    let body_at = out.begin();
    let mut st = Imps { buf: Vec::with_capacity(input.len()), ids: Vec::with_capacity(64), ..Default::default() };

    let mut w = W { b: &mut *out };
    w.open(b'{');
    // site/app/ext are rewritten from the imps' params, so they are held as spans; every other
    // member is copied as it streams by. The imps need req.app (for `dm`), which the Host writes
    // after them: they are processed in place, speculating that no app comes, and redone from
    // their span in the rare case one does and yields a `dm`.
    let (mut imp, mut site, mut app, mut ext) = (None, None, None, None);
    let mut spec_app = None; // the app the imps were processed with
    let mut site_done = false; // site rewritten in place (the imps, hence `pub`, came first)
    P::new(input).obj(|p, k| match &*j::key(k) {
        b"imp" => {
            if cfg!(feature = "abl_twopass") {
                imp = Some(p.raw());
            } else {
                p.peek();
                let start = p.i;
                run_imps(p, app, &mut st);
                imp = Some(&input[start..p.i]);
                spec_app = Some(app);
            }
        }
        b"site" if !cfg!(feature = "abl_rescan") && spec_app.is_some() && p.peek() == b'{' => {
            site = Some(&b"{}"[..]); // only truth-tested from here on
            site_done = true;
            publisher(&mut w, key_site, p, st.fold.publisher.as_deref());
        }
        b"site" => site = Some(p.raw()),
        b"app" => app = Some(p.raw()),
        b"ext" => ext = Some(p.raw()),
        _ => {
            let v = p.raw();
            w.member(k, v)
        }
    });
    let redo = match spec_app {
        None => true,
        Some(a) => a.is_none() && app.is_some() && dm(app).is_some(),
    };
    if redo {
        match imp {
            Some(imp) => run_imps(&mut P::new(imp), app, &mut st),
            None => run_imps(&mut P::new(b"[]"), app, &mut st),
        }
    }
    let Imps { buf, ids, n, errs, fold } = st;
    if n == 0 {
        out.clear();
        out.u32(0);
    } else {
        key!(w, "imp");
        w.b.extend_from_slice(&buf);
        w.close(b']');
        request_ext(&mut w, ext, &fold);
        if site_done {
        } else if j::present(site) {
            publisher(&mut w, key_site, &mut P::new(site.unwrap()), fold.publisher.as_deref());
        } else if let Some(s) = site {
            key!(w, "site");
            w.raw(s);
        }
        if j::present(app) && !j::truthy(site) {
            publisher(&mut w, key_app, &mut P::new(app.unwrap()), fold.publisher.as_deref());
        } else if let Some(a) = app {
            key!(w, "app");
            w.raw(a);
        }
        w.close(b'}');
        out.end(body_at);
    }
    out.extend_from_slice(&ids);
    out.u32(errs.len() as u32);
    errs.iter().for_each(|e| out.bytes(e.as_bytes()));
}

fn key_site(w: &mut W) {
    key!(w, "site");
}
fn key_app(w: &mut W) {
    key!(w, "app");
}

/// One imp: streams it into the output, then either finishes it (returning its params and id) or
/// rolls the output back and records the error.
fn one_imp<'a>(p: &mut P<'a>, w: &mut W, dm: Option<Dm<'a>>, errs: &mut Vec<String>) -> Option<(Params<'a>, S<'a>)> {
    let mark = w.mark();
    w.elem();
    w.open(b'{');
    let (mut id, mut banner, mut video, mut native) = (None, None, None, None);
    let (mut dmgr, mut dmgrv, mut tagid, mut bidfloor) = (None, None, None, None);
    let mut x = ImpExt::default();
    p.obj(|p, k| match &*j::key(k) {
        b"banner" => banner = Some(p.raw()),
        b"audio" => p.ignore(), // audio: ~
        b"displaymanager" => dmgr = Some(p.raw()),
        b"displaymanagerver" => dmgrv = Some(p.raw()),
        b"tagid" => tagid = Some(p.raw()),
        b"bidfloor" => bidfloor = Some(p.raw()),
        b"ext" => x = imp_ext(p),
        kk => {
            let v = p.raw();
            match kk {
                b"id" => id = Some(v),
                b"video" => video = Some(v),
                b"native" => native = Some(v),
                _ => {}
            }
            w.member(k, v)
        }
    });
    let pr = x.bidder;
    let fail = |w: &mut W, errs: &mut Vec<String>, e: String| {
        w.b.truncate(mark);
        errs.push(e);
        None
    };
    if !(j::truthy(banner) || j::truthy(video) || j::truthy(native)) {
        let e = format!("invalid MediaType. PubMatic only supports Banner, Video and Native. Ignoring ImpID={}", id.and_then(j::scalar).unwrap_or_default());
        return fail(w, errs, e);
    }

    // slot = trim(str(p.adSlot)); at = split(slot, '@'); sz = split(lower(at[1]), 'x'); ...
    let slot: Option<S<'a>> = pr.ad_slot.and_then(j::scalar).map(|s| j::trim(&s));
    let at = j::split(slot.as_deref(), '@');
    let at1_lower = at.nth(1).map(|s| j::lower(&j::view(s)));
    let sz = j::split(at1_lower.as_deref(), 'x');
    let wd = sz.nth(0).map(j::trim_str).and_then(j::int_str);
    let ht = sz.nth(1).and_then(|s| s.split(':').next()).map(j::trim_str).and_then(j::int_str);
    let has_size = slot.as_deref().map_or(false, |s| s.contains('@'));
    let slot_s = slot.as_deref().unwrap_or("");
    if has_size && !(at.len() == 2 && at.nth(0) != Some("") && at.nth(1) != Some("")) {
        return fail(w, errs, format!("Invalid adSlot {slot_s}"));
    }
    if has_size && sz.len() != 2 {
        return fail(w, errs, format!("Invalid size provided in adSlot {slot_s}"));
    }
    if has_size && wd.is_none() {
        return fail(w, errs, format!("Invalid width provided in adSlot {slot_s}"));
    }
    if has_size && ht.is_none() {
        return fail(w, errs, format!("Invalid height provided in adSlot {slot_s}"));
    }

    // displaymanager / displaymanagerver
    let use_dm = !j::truthy(dmgr) && !j::truthy(dmgrv) && dm.is_some();
    let (dmgr, dmgrv) = if use_dm { (dm.unwrap().source, dm.unwrap().version) } else { (dmgr, dmgrv) };
    if let Some(v) = dmgr {
        key!(w, "displaymanager");
        w.raw(v);
    }
    if let Some(v) = dmgrv {
        key!(w, "displaymanagerver");
        w.raw(v);
    }
    // tagid: slot == '' ? keep : hasSize ? trim(at[0]) : slot
    if slot.as_deref() == Some("") {
        if let Some(v) = tagid {
            key!(w, "tagid");
            w.raw(v);
        }
    } else if has_size {
        key!(w, "tagid");
        w.str_(j::trim_str(at.nth(0).unwrap_or("")));
    } else if let Some(s) = &slot {
        key!(w, "tagid");
        w.str_(s);
    }
    // banner?.w / banner?.h
    if let Some(b) = banner {
        key!(w, "banner");
        if j::is_null(b) {
            w.raw(b);
        } else {
            banner_wh(w, b, has_size, wd, ht);
        }
    }
    // bidfloor: kad != null ? max(kad, imp.bidfloor ?? 0) : keep
    let kad = pr.kadfloor.and_then(j::scalar).and_then(|s| j::num_str(j::trim_str(&s)));
    match kad {
        Some(kad) => {
            let floor = match bidfloor {
                None => Some(0.0),
                Some(r) if j::is_null(r) => Some(0.0),
                Some(r) => j::num(r),
            };
            if let Some(f) = floor {
                key!(w, "bidfloor");
                w.num(j::js_max(kad, f));
            }
        }
        None => {
            if let Some(v) = bidfloor {
                key!(w, "bidfloor");
                w.raw(v);
            }
        }
    }
    ext(w, &x);
    w.close(b'}');
    let id = id.and_then(j::jstr).map(|s| s.cow()).unwrap_or_default();
    Some((pr, id))
}

/// Writes `banner` with w/h set: hasSize ? w : (imp.banner.w != null && imp.banner.h != null) ? keep
/// : imp.banner.format[0].w (and the same for h).
fn banner_wh(w: &mut W, b: Raw, has_size: bool, wd: Option<f64>, ht: Option<f64>) {
    let is_obj = b.first() == Some(&b'{');
    if !is_obj && !has_size {
        return w.raw(b);
    }
    w.open(b'{');
    let (mut bw, mut bh, mut format) = (None, None, None);
    P::new(b).obj(|p, k| match &*j::key(k) {
        b"w" => bw = Some(p.raw()),
        b"h" => bh = Some(p.raw()),
        kk => {
            let v = p.raw();
            if kk == b"format" {
                format = Some(v);
            }
            w.member(k, v)
        }
    });
    if has_size {
        key!(w, "w");
        w.num(wd.unwrap());
        key!(w, "h");
        w.num(ht.unwrap());
    } else if j::present(bw) && j::present(bh) {
        key!(w, "w");
        w.raw(bw.unwrap());
        key!(w, "h");
        w.raw(bh.unwrap());
    } else {
        let f0 = j::nth(format, 0);
        if let Some(v) = j::get(f0, "w") {
            key!(w, "w");
            w.raw(v);
        }
        if let Some(v) = j::get(f0, "h") {
            key!(w, "h");
            w.raw(v);
        }
    }
    w.close(b'}');
}

/// `kw`: fromEntries(p.keywords.filter(k, len(k.value) > 0).map(k, {k: ..., v: join(k.value, ',')})),
/// as an ordered list with JS assignment semantics (a repeated key keeps its first position).
type Kw<'a> = Vec<(S<'a>, String)>;
fn kw_put<'a>(kw: &mut Kw<'a>, k: S<'a>, v: String) {
    match kw.iter_mut().find(|(x, _)| *x == k) {
        Some(e) => e.1 = v,
        None => kw.push((k, v)),
    }
}
fn kw_get<'k>(kw: &'k Kw, k: &str) -> Option<&'k str> {
    kw.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str())
}
fn keyword<'a>(r: Raw<'a>) -> (Option<Raw<'a>>, Option<Raw<'a>>) {
    let (mut key, mut value) = (None, None);
    P::new(r).obj(|p, k| match &*j::key(k) {
        b"key" => key = Some(p.raw()),
        b"value" => value = Some(p.raw()),
        _ => p.ignore(),
    });
    (key, value)
}
fn kw_map<'a>(key: Option<Raw<'a>>, value: Option<Raw<'a>>) -> Option<(S<'a>, String)> {
    let k = key.and_then(j::jstr)?.cow();
    let k = if k == *lit!("pmZoneID") { j::view_cow(lit!("pmZoneId")) } else { k };
    let mut v = String::new();
    j::join(value, &lit!(","), &mut v);
    Some((k, v))
}
/// The fused pipeline, run while decoding: one walk over the keywords, joining each value as it
/// is read and counting it for the `len(k.value) > 0` filter.
fn keywords_in<'a>(p: &mut P<'a>) -> Kw<'a> {
    let mut kw = Kw::new();
    let sep = lit!(",");
    p.arr(|p| {
        let (mut key, mut v, mut n) = (None, String::new(), None);
        p.obj(|p, k| match &*j::key(k) {
            b"key" => key = Some(p.raw()),
            b"value" => {
                v.clear();
                n = match p.peek() {
                    b'[' => {
                        let (mut c, mut first) = (0, true);
                        p.arr(|p| {
                            c += 1;
                            if let Some(s) = j::scalar(p.raw()) {
                                if !first {
                                    v.push_str(&sep);
                                }
                                v.push_str(&s);
                                first = false;
                            }
                        });
                        Some(c)
                    }
                    b'{' => Some(j::members(p.raw()).len()), // len counts members; join gives ""
                    _ => {
                        p.raw();
                        None
                    }
                };
            }
            _ => p.ignore(),
        });
        if n.map_or(false, |n| n > 0) {
            if let Some(k) = key.and_then(j::jstr) {
                let k = k.cow();
                let k = if k == *lit!("pmZoneID") { j::view_cow(lit!("pmZoneId")) } else { k };
                kw_put(&mut kw, k, std::mem::take(&mut v));
            }
        }
    });
    kw
}
fn keywords<'a>(raw: Option<Raw<'a>>) -> Kw<'a> {
    let mut kw = Kw::new();
    let Some(raw) = raw else { return kw };
    if cfg!(feature = "abl_unfused") {
        // list → filter → map → fromEntries, each step its own list
        let mut all = Vec::new();
        P::new(raw).arr(|p| all.push(keyword(p.raw())));
        let kept: Vec<_> = all.into_iter().filter(|(_, v)| j::len(*v).map_or(false, |n| n > 0)).collect();
        let mapped: Vec<_> = kept.into_iter().filter_map(|(k, v)| kw_map(k, v)).collect();
        for (k, v) in mapped {
            kw_put(&mut kw, k, v);
        }
        return kw;
    }
    P::new(raw).arr(|p| {
        let (key, value) = keyword(p.raw());
        if j::len(value).map_or(false, |n| n > 0) {
            if let Some((k, v)) = kw_map(key, value) {
                kw_put(&mut kw, k, v);
            }
        }
    });
    kw
}

/// One `pairs` element: `${trim(e.k)}=${string ? trim(v) : array ? join(v.map(trim), ',') : v}`.
fn pair(out: &mut String, k: &str, v: Raw) {
    out.push_str(j::trim_str(k));
    out.push('=');
    match v.first() {
        Some(b'"') => out.push_str(j::trim_str(&j::jstr(v).unwrap().cow())),
        Some(b'[') => {
            let mut first = true;
            P::new(v).arr(|p| {
                if let Some(s) = p.str() {
                    if !first {
                        out.push(',');
                    }
                    out.push_str(j::trim_str(&s.cow()));
                    first = false;
                }
            });
        }
        _ => {
            if let Some(s) = j::scalar(v) {
                out.push_str(&s)
            }
        }
    }
}

/// key_val: nonempty(join([p.dctr || kw.key_val, ...pairs].filter(s, s), '|')), built in one pass.
fn key_val(first: Option<&str>, data: Option<Raw>) -> Option<String> {
    let skip = |k: &str| k == &*lit!("pbadslot") || k == &*lit!("adserver");
    let entries = match data {
        Some(d) if d.first() == Some(&b'{') => j::members(d),
        _ => Vec::new(),
    };
    if cfg!(feature = "abl_unfused") {
        let kept: Vec<_> = entries.into_iter().filter(|(k, _)| !skip(k)).collect();
        let pairs: Vec<String> = kept.iter().map(|(k, v)| {
            let mut s = String::new();
            pair(&mut s, k, v);
            s
        }).collect();
        let mut list: Vec<String> = first.map(str::to_owned).into_iter().collect();
        list.extend(pairs);
        let list: Vec<String> = list.into_iter().filter(|s| !s.is_empty()).collect();
        let s = list.join("|");
        return (!s.is_empty()).then_some(s);
    }
    let mut s = String::new();
    if let Some(f) = first.filter(|f| !f.is_empty()) {
        s.push_str(f);
    }
    for (k, v) in &entries {
        if !skip(k) {
            if !s.is_empty() {
                s.push('|');
            }
            pair(&mut s, k, v);
        }
    }
    (!s.is_empty()).then_some(s)
}

/// imp.ext = nonempty(merge(kw, {key_val, pmZoneId, dfp_ad_unit_code, ae, gpid, skadn})).
fn ext(w: &mut W, x: &ImpExt) {
    let p = &x.bidder;
    let kw_own;
    let kw = if cfg!(feature = "abl_unfused") {
        kw_own = keywords(p.keywords);
        &kw_own
    } else {
        &x.kw
    };
    let dctr = p.dctr.map(|s| s.cow()).filter(|s| !s.is_empty());
    let kv = key_val(dctr.as_deref().or(kw_get(kw, "key_val")), x.data);
    let pmz_own = p.pmzoneid.filter(|s| !s.is_empty());
    let pmz_kw = if pmz_own.is_none() { kw_get(kw, "pmZoneId") } else { None };
    let adserver = j::get(x.data, "adserver");
    let gam = j::get(adserver, "name").and_then(j::jstr).map_or(false, |n| n.cow() == *lit!("gam"));
    let adslot = j::get(adserver, "adslot");
    let dfp = if gam && j::truthy(adslot) { adslot } else { j::get(x.data, "pbadslot") };
    let ae = x.ae.filter(|v| j::truthy(Some(v)));
    let gpid = x.gpid.filter(|v| j::truthy(Some(v)));

    let mark = w.mark();
    key!(w, "ext");
    let body = w.open(b'{');
    for (k, v) in kw {
        let overridden = match k.as_ref() {
            "key_val" => kv.is_some(),
            "pmZoneId" => pmz_own.is_some() || pmz_kw.is_some(),
            "dfp_ad_unit_code" => dfp.is_some(),
            "ae" => ae.is_some(),
            "gpid" => gpid.is_some(),
            "skadn" => x.skadn.is_some(),
            _ => false,
        };
        if !overridden {
            w.key_str(k);
            w.b.push(b':');
            w.str_(v);
        }
    }
    if let Some(v) = &kv {
        key!(w, "key_val");
        w.str_(v);
    }
    if let Some(v) = pmz_own {
        key!(w, "pmZoneId");
        w.jstr(v);
    } else if let Some(v) = pmz_kw {
        key!(w, "pmZoneId");
        w.str_(v);
    }
    if let Some(v) = dfp {
        key!(w, "dfp_ad_unit_code");
        w.raw(v);
    }
    if let Some(v) = ae {
        key!(w, "ae");
        w.raw(v);
    }
    if let Some(v) = gpid {
        key!(w, "gpid");
        w.raw(v);
    }
    if let Some(v) = x.skadn {
        key!(w, "skadn");
        w.raw(v);
    }
    w.close_nonempty(mark, body);
}

/// req.ext.prebid, as far as the request phase reads it.
#[derive(Default)]
struct Prebid<'a> {
    profile: Option<Raw<'a>>,
    version: Option<Raw<'a>>,
    acat: Option<Raw<'a>>,
    abc: Option<Raw<'a>>,
    aliases: Option<Raw<'a>>,
}
fn prebid<'a>(ext: Option<Raw<'a>>) -> Prebid<'a> {
    let mut x = Prebid::default();
    let Some(prebid) = j::get(ext, "prebid") else { return x };
    P::new(prebid).obj(|p, k| match &*j::key(k) {
        b"bidderparams" => {
            (x.profile, x.version, x.acat) = (None, None, None);
            p.obj(|p, k| match &*j::key(k) {
                b"wrapper" => {
                    (x.profile, x.version) = (None, None);
                    p.obj(|p, k| match &*j::key(k) {
                        b"profile" => x.profile = Some(p.raw()),
                        b"version" => x.version = Some(p.raw()),
                        _ => p.ignore(),
                    });
                }
                b"acat" => x.acat = Some(p.raw()),
                _ => p.ignore(),
            });
        }
        b"alternatebiddercodes" => x.abc = Some(p.raw()),
        b"aliases" => x.aliases = Some(p.raw()),
        _ => p.ignore(),
    });
    x
}

fn request_ext(w: &mut W, ext: Option<Raw>, fold: &Fold) {
    let pb = prebid(ext);
    key!(w, "ext");
    w.open(b'{');
    // wrapper: nonempty({profile, version, biddercode})
    let mark = w.mark();
    key!(w, "wrapper");
    let body = w.open(b'{');
    let profile = if j::truthy(pb.profile) { pb.profile } else { fold.profile };
    if let Some(v) = profile {
        key!(w, "profile");
        w.raw(v);
    }
    let version = if j::truthy(pb.version) { pb.version } else { fold.version };
    if let Some(v) = version {
        key!(w, "version");
        w.raw(v);
    }
    if j::truthy(ext) {
        key!(w, "biddercode");
        match j::first_key(pb.aliases) {
            Some(k) => w.str_(&k),
            None => w.str_(&lit!("pubmatic")),
        }
    }
    w.close_nonempty(mark, body);
    // acat: nonempty(bp.acat.map(a, trim(a)))
    if let Some(acat) = pb.acat {
        let mark = w.mark();
        key!(w, "acat");
        w.open(b'[');
        let body = w.mark();
        if cfg!(feature = "abl_unfused") {
            let mut all = Vec::new();
            P::new(acat).arr(|p| all.push(p.str()));
            let trimmed: Vec<String> = all.into_iter().flatten().map(|s| j::trim_str(&s.cow()).to_owned()).collect();
            for s in &trimmed {
                w.elem();
                w.str_(s);
            }
        } else {
            P::new(acat).arr(|p| {
                if let Some(s) = p.str() {
                    w.elem();
                    w.str_(j::trim_str(&s.cow()));
                }
            });
        }
        if w.mark() == body {
            w.b.truncate(mark);
        } else {
            w.close(b']');
        }
    }
    // marketplace
    if j::present(pb.abc) {
        let pm = j::get(j::get(pb.abc, "bidders"), "pubmatic");
        key!(w, "marketplace");
        w.open(b'{');
        key!(w, "allowedbidders");
        w.open(b'[');
        let codes = j::get(pm, "allowedbiddercodes");
        if !(j::truthy(j::get(pb.abc, "enabled")) && j::truthy(j::get(pm, "enabled"))) {
            w.str_(&lit!("pubmatic"));
        } else if !j::present(codes) || (j::len(codes) == Some(1) && j::nth(codes, 0).and_then(j::jstr).map_or(false, |s| s.cow() == *lit!("*"))) {
            w.str_(&lit!("all"));
        } else {
            w.str_(&lit!("pubmatic"));
            if codes.unwrap().first() == Some(&b'[') {
                P::new(codes.unwrap()).arr(|p| {
                    let v = p.raw();
                    w.elem();
                    w.raw(v);
                });
            }
        }
        w.close(b']');
        w.close(b'}');
    }
    w.close(b'}');
}

/// site?.publisher.id / app?.publisher.id: pub || ~ (a copy-on-write put along the path).
fn publisher(w: &mut W, key: fn(&mut W), p: &mut P, id: Option<&str>) {
    key(w);
    if p.peek() != b'{' {
        // not an object: put replaces it when setting, leaves it when deleting
        let o = p.raw();
        return match id {
            Some(id) => {
                w.b.extend_from_slice(b"{\"publisher\":{\"id\":");
                w.str_(id);
                w.b.extend_from_slice(b"}}");
            }
            None => w.raw(o),
        };
    }
    w.open(b'{');
    let mut seen = false;
    p.obj(|p, k| {
        if &*j::key(k) != b"publisher" {
            let v = p.raw();
            return w.member(k, v);
        }
        seen = true;
        if p.peek() == b'{' {
            key!(w, "publisher");
            w.open(b'{');
            p.obj(|p, k| {
                let v = p.raw();
                if &*j::key(k) != b"id" {
                    w.member(k, v);
                }
            });
            if let Some(id) = id {
                key!(w, "id");
                w.str_(id);
            }
            w.close(b'}');
        } else {
            let v = p.raw();
            match id {
                Some(id) => {
                    key!(w, "publisher");
                    w.b.extend_from_slice(b"{\"id\":");
                    w.str_(id);
                    w.close(b'}');
                }
                None => w.member(k, v),
            }
        }
    });
    if !seen {
        if let Some(id) = id {
            key!(w, "publisher");
            w.b.extend_from_slice(b"{\"id\":");
            w.str_(id);
            w.close(b'}');
        }
    }
    w.close(b'}');
}

// ---------- MakeBids ----------

thread_local! {
    /// Dynamic fallback for `json(bid.adm)`: the native adm is untyped JSON, read with the
    /// profile-compiler runtime (cold path: native bids only).
    static DOC: std::cell::RefCell<prebid_core_rt::Doc> = std::cell::RefCell::new(prebid_core_rt::Doc::new());
}

/// `nat = json(bid.adm)`: (nat == null, stringify(nat.native) as a JSON string literal).
fn native_adm(adm: Option<Raw>) -> (bool, Option<Vec<u8>>) {
    let Some(s) = adm.and_then(j::jstr) else { return (true, None) };
    DOC.with(|d| {
        let mut d = d.borrow_mut();
        d.reset();
        let lit = d.lit(std::str::from_utf8(s.0).unwrap_or(""));
        let nat = d.json(lit);
        if d.nullish(nat) {
            return (true, None);
        }
        let n = d.get(nat, "native");
        if d.nullish(n) {
            return (false, None);
        }
        let st = d.stringify(n);
        (false, Some(d.to_json(st)))
    })
}

#[derive(Default)]
struct Bid<'a> {
    impid: Option<Raw<'a>>,
    mtype: Option<Raw<'a>>,
    adm: Option<Raw<'a>>,
    cat: Option<Raw<'a>>,
    ext: Option<Raw<'a>>,
    marketplace: Option<Raw<'a>>,
    dealpriority: Option<Raw<'a>>,
    duration: Option<Raw<'a>>,
    ibv: Option<Raw<'a>>,
}
fn bid<'a>(p: &mut P<'a>) -> Bid<'a> {
    let mut b = Bid::default();
    p.obj(|p, k| match &*j::key(k) {
        b"impid" => b.impid = Some(p.raw()),
        b"mtype" => b.mtype = Some(p.raw()),
        b"adm" => b.adm = Some(p.raw()),
        b"cat" => b.cat = Some(p.raw()),
        b"ext" => j::with(p, |p| {
            // decoded in place; `bid.ext` itself is only truth-tested, so a marker span will do
            (b.marketplace, b.dealpriority, b.duration, b.ibv) = (None, None, None, None);
            if p.peek() != b'{' {
                b.ext = Some(p.raw());
                return;
            }
            b.ext = Some(&b"{}"[..]);
            p.obj(|p, k| match &*j::key(k) {
                b"marketplace" => b.marketplace = Some(p.raw()),
                b"prebiddealpriority" => b.dealpriority = Some(p.raw()),
                b"ibv" => b.ibv = Some(p.raw()),
                b"video" => {
                    b.duration = None;
                    p.obj(|p, k| match &*j::key(k) {
                        b"duration" => b.duration = Some(p.raw()),
                        _ => p.ignore(),
                    });
                }
                _ => p.ignore(),
            });
        }),
        _ => p.ignore(),
    });
    b
}

/// {1: 'banner', 2: 'video', 3: 'audio', 4: 'native'}[bid.mtype]
fn bid_type(m: Option<Raw>) -> Option<&'static str> {
    let m = m?;
    let k = match m.first()? {
        b'"' => match j::jstr(m)?.0 {
            b"1" => 1.0,
            b"2" => 2.0,
            b"3" => 3.0,
            b"4" => 4.0,
            _ => return None,
        },
        _ => j::num(m)?,
    };
    match k {
        1.0 => Some("banner"),
        2.0 => Some("video"),
        3.0 => Some("audio"),
        4.0 => Some("native"),
        _ => None,
    }
}

fn one_bid(p: &mut P, out: &mut Vec<u8>, errs: &mut Vec<String>) {
    let b = bid(p);
    let Some(typ) = bid_type(b.mtype) else {
        let m = b.mtype.filter(|m| !j::is_null(m)).map_or(Cow::Borrowed("0"), |m| j::scalar(m).unwrap_or_default());
        errs.push(format!("failed to parse bid mtype ({m}) for impression id {}", b.impid.and_then(j::scalar).unwrap_or_default()));
        out.u32(0);
        for _ in 0..2 {
            out.u32(0);
        }
        out.u32(0);
        for _ in 0..3 {
            out.u32(0);
        }
        return;
    };
    let (nat_null, nat_native) = if typ == "native" { native_adm(b.adm) } else { (true, None) };
    if typ == "native" && nat_null {
        errs.push("unable to unmarshal native adm".into());
    }
    out.u32(1);
    out.bytes(typ.as_bytes());
    let seat = b.marketplace.and_then(j::jstr).map(|s| s.cow()).unwrap_or_default();
    out.bytes(seat.as_bytes());
    let dp = b.dealpriority.and_then(j::num).filter(|f| *f > 0.0).unwrap_or(0.0);
    out.u32(dp as i32 as u32);
    crate::kv1(out, "duration", b.duration);
    if j::truthy(b.ext) {
        let slot = crate::kv_begin(out);
        let mt = if j::truthy(b.ibv) { "video" } else { typ };
        crate::kv_member(out, "mediaType", 0, mt.as_bytes());
        crate::kv_end(out, slot, 1);
    } else {
        out.u32(0);
    }
    // overrides: cat, adm
    let at = out.begin();
    let mut w = W { b: &mut *out };
    let body = w.open(b'{');
    if j::len(b.cat).map_or(false, |n| n > 1) {
        key!(w, "cat");
        w.open(b'[');
        if let Some(c) = j::nth(b.cat, 0) {
            w.raw(c);
        }
        w.close(b']');
    }
    if let Some(adm) = nat_native {
        key!(w, "adm");
        w.b.extend_from_slice(&adm);
    }
    if w.b.len() == body {
        out.truncate(at);
        out.u32(0);
    } else {
        w.close(b'}');
        out.end(at);
    }
}

pub fn make_bids(req: &[u8], resp: &[u8], out: &mut Vec<u8>) {
    if cfg!(feature = "abl_eager") {
        // nothing in PubMatic's bid phase reads the request; this scans it anyway
        std::hint::black_box(P::new(req).raw());
    }
    let n_at = out.begin();
    let mut n = 0;
    let mut errs: Vec<String> = Vec::new();
    let (mut cur, mut rext) = (None, None);
    P::new(resp).obj(|p, k| match &*j::key(k) {
        b"seatbid" => {
            p.arr(|p| {
                p.obj(|p, k| {
                    if &*j::key(k) == b"bid" {
                        p.arr(|p| {
                            j::with(p, |p| one_bid(p, out, &mut errs));
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
    out.u32(errs.len() as u32);
    errs.iter().for_each(|e| out.bytes(e.as_bytes()));
}
