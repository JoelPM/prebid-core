//! #3's guest: PBS-Go adapters/openx/openx.go ported over serde_json::Value (whole-tree parse,
//! clone, re-serialize). Kept as the baseline the typed guest is measured against.
use crate::{imp_type, Imps};
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

fn bid_value(bid: &Value, typ: &str) -> Value {
    let p = |k: &str| bid["ext"][k].as_str().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    let (buyer, dsp, brand) = (p("buyer_id"), p("dsp_id"), p("brand_id"));
    let meta = if buyer > 0 || dsp > 0 || brand > 0 { json!({"networkId":dsp,"advertiserId":buyer,"brandId":brand}) } else { Value::Null };
    json!({"bid": bid, "type": typ,
        "video": {"primary_category": bid["cat"][0].as_str().unwrap_or(""), "duration": bid["dur"].as_i64().unwrap_or(0)}, "meta": meta})
}

/// MakeRequests: request JSON in, outgoing OpenX body out.
pub fn make_requests(req: &[u8], out: &mut Vec<u8>) {
    let req: Value = serde_json::from_slice(req).unwrap();
    serde_json::to_writer(out, &make_request(&req)).unwrap();
}

/// MakeBids: imp table + response JSON in, `{"bids":[{bid,type,video,meta}],"cur"}` out.
pub fn make_bids(imps: &Imps, resp: &[u8], out: &mut Vec<u8>) {
    let resp: Value = serde_json::from_slice(resp).unwrap();
    let mut bids = Vec::new();
    for sb in resp["seatbid"].as_array().into_iter().flatten() {
        for bid in sb["bid"].as_array().into_iter().flatten() {
            let typ = imp_type(bid["mtype"].as_i64(), bid["impid"].as_str().unwrap_or(""), imps);
            bids.push(bid_value(bid, typ));
        }
    }
    serde_json::to_writer(out, &json!({"bids": bids, "cur": resp["cur"].as_str().unwrap_or("USD")})).unwrap();
}

/// #3's single-call ABI: request + response in, `{"body":"<escaped json>","bids":[..],"cur"}` out.
/// MakeBids re-reads the request to resolve bid types.
pub fn run_legacy(req_json: &[u8], resp_json: &[u8]) -> Vec<u8> {
    let req: Value = serde_json::from_slice(req_json).unwrap();
    let body = serde_json::to_string(&make_request(&req)).unwrap();
    let resp: Value = serde_json::from_slice(resp_json).unwrap();
    let mut bids = Vec::new();
    for sb in resp["seatbid"].as_array().into_iter().flatten() {
        for bid in sb["bid"].as_array().into_iter().flatten() {
            let typ = match bid["mtype"].as_i64() {
                Some(1) => "banner", Some(2) => "video", Some(4) => "native",
                _ => req["imp"].as_array().into_iter().flatten().find(|i| i["id"] == bid["impid"]).map_or("banner", |imp| {
                    if imp.get("banner").is_none() && imp.get("video").is_some() { "video" }
                    else if imp.get("banner").is_none() && imp.get("native").is_some() { "native" } else { "banner" }
                }),
            };
            bids.push(bid_value(bid, typ));
        }
    }
    serde_json::to_vec(&json!({"body": body, "bids": bids, "cur": resp["cur"].as_str().unwrap_or("USD")})).unwrap()
}
