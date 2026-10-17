//! Port of PBS-Go adapters/openx/openx.go (MakeRequests + MakeBids) over serde_json::Value.
use serde_json::{json, Map, Value};

fn make_request(req: &Value) -> Value {
    let mut ext = Map::new();
    ext.insert("bc".into(), json!("hb_pbs_1.0.0"));
    let mut imps = Vec::new();
    for src in req["imp"].as_array().into_iter().flatten() {
        if src.get("banner").is_none() && src.get("video").is_none() && src.get("native").is_none() {
            continue;
        }
        let mut imp = src.as_object().cloned().unwrap_or_default();
        let iext = imp.get("ext").and_then(Value::as_object).cloned().unwrap_or_default();
        let Some(ox) = iext.get("bidder").and_then(Value::as_object) else { continue };
        if let Some(d) = ox.get("delDomain") { ext.insert("delDomain".into(), d.clone()); }
        if let Some(p) = ox.get("platform") { ext.insert("platform".into(), p.clone()); }
        let unit = match ox.get("unit") { Some(Value::String(s)) => s.clone(), Some(v) => v.to_string(), None => String::new() };
        imp.insert("tagid".into(), Value::String(unit));
        if imp.get("bidfloor").and_then(Value::as_f64).unwrap_or(0.0) == 0.0 {
            if let Some(f) = ox.get("customFloor").and_then(Value::as_f64) { if f > 0.0 { imp.insert("bidfloor".into(), json!(f)); } }
        }
        let mut out_ext = iext.clone();
        out_ext.remove("prebid");
        out_ext.remove("bidder");
        if let Some(cp) = ox.get("customParams") { out_ext.insert("customParams".into(), cp.clone()); }
        if out_ext.is_empty() { imp.remove("ext"); } else { imp.insert("ext".into(), Value::Object(out_ext)); }
        let rwdd = imp.get("rwdd").and_then(Value::as_i64) == Some(1);
        if let Some(Value::Object(v)) = imp.get_mut("video") {
            if rwdd { v.insert("ext".into(), json!({"rewarded":1})); } else { v.remove("ext"); }
        }
        imps.push(Value::Object(imp));
    }
    let mut out = req.as_object().cloned().unwrap_or_default();
    out.insert("imp".into(), Value::Array(imps));
    out.insert("ext".into(), Value::Object(ext));
    Value::Object(out)
}

fn bid_type(bid: &Value, req: &Value) -> &'static str {
    match bid["mtype"].as_i64() {
        Some(1) => "banner", Some(2) => "video", Some(4) => "native",
        _ => {
            for imp in req["imp"].as_array().into_iter().flatten() {
                if imp["id"] == bid["impid"] {
                    if imp.get("banner").is_none() && imp.get("video").is_some() { return "video"; }
                    if imp.get("banner").is_none() && imp.get("native").is_some() { return "native"; }
                    return "banner";
                }
            }
            "banner"
        }
    }
}

pub fn run(req_json: &[u8], resp_json: &[u8]) -> Vec<u8> {
    let req: Value = serde_json::from_slice(req_json).unwrap();
    let body = serde_json::to_string(&make_request(&req)).unwrap();
    let resp: Value = serde_json::from_slice(resp_json).unwrap();
    let mut bids = Vec::new();
    for sb in resp["seatbid"].as_array().into_iter().flatten() {
        for bid in sb["bid"].as_array().into_iter().flatten() {
            let p = |k: &str| bid["ext"][k].as_str().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
            let (buyer, dsp, brand) = (p("buyer_id"), p("dsp_id"), p("brand_id"));
            let meta = if buyer > 0 || dsp > 0 || brand > 0 { json!({"networkId":dsp,"advertiserId":buyer,"brandId":brand}) } else { Value::Null };
            bids.push(json!({"bid": bid, "type": bid_type(bid, &req),
                "video": {"primary_category": bid["cat"][0].as_str().unwrap_or(""), "duration": bid["dur"].as_i64().unwrap_or(0)}, "meta": meta}));
        }
    }
    serde_json::to_vec(&json!({"body": body, "bids": bids, "cur": resp["cur"].as_str().unwrap_or("USD")})).unwrap()
}

// ---- wasm ABI ----
static mut LAST: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn alloc(n: u32) -> u32 {
    let mut v = Vec::<u8>::with_capacity(n as usize);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p as usize as u32
}
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: u32, n: u32) { drop(Vec::from_raw_parts(p as usize as *mut u8, 0, n as usize)); }
#[no_mangle]
pub unsafe extern "C" fn adapt(rp: u32, rl: u32, sp: u32, sl: u32) -> u64 {
    let req = std::slice::from_raw_parts(rp as usize as *const u8, rl as usize);
    let resp = std::slice::from_raw_parts(sp as usize as *const u8, sl as usize);
    let out = run(req, resp);
    let r = ((out.as_ptr() as usize as u64) << 32) | out.len() as u64;
    #[allow(static_mut_refs)]
    { LAST = out; }
    r
}
#[no_mangle]
pub extern "C" fn noop(x: u32) -> u32 { x + 1 }
