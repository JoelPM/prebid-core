//! Toy "OpenX-like" Shared Adapter: pure translation, JSON in / JSON out over a raw C ABI.
//! No wasm-bindgen; host passes UTF-8 buffers via alloc/dealloc.
use serde_json::{json, Map, Value};
use std::alloc::{alloc as sys_alloc, dealloc as sys_dealloc, Layout};

static mut OUT: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    unsafe { sys_alloc(Layout::from_size_align_unchecked(len.max(1), 1)) }
}
#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe { sys_dealloc(ptr, Layout::from_size_align_unchecked(len.max(1), 1)) }
}
#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 { unsafe { (*std::ptr::addr_of!(OUT)).as_ptr() } }
#[no_mangle]
pub extern "C" fn out_len() -> usize { unsafe { (*std::ptr::addr_of!(OUT)).len() } }

fn input(ptr: *const u8, len: usize) -> Value {
    let s = unsafe { std::slice::from_raw_parts(ptr, len) };
    serde_json::from_slice(s).unwrap_or(Value::Null)
}
fn output(v: Value) -> usize {
    let b = serde_json::to_vec(&v).unwrap_or_default();
    unsafe { OUT = b; (*std::ptr::addr_of!(OUT)).len() }
}

#[no_mangle]
pub extern "C" fn is_bid_request_valid(ptr: *const u8, len: usize) -> u32 {
    let b = input(ptr, len);
    let p = &b["params"];
    let has_del = p["delDomain"].is_string() || p["platform"].is_string();
    let has_unit = p["unit"].is_string() || p["unit"].is_number();
    (has_del && has_unit) as u32
}

#[no_mangle]
pub extern "C" fn build_requests(ptr: *const u8, len: usize) -> usize {
    let inp = input(ptr, len);
    let bids = inp["bidRequests"].as_array().cloned().unwrap_or_default();
    let ortb2 = inp["bidderRequest"]["ortb2"].clone();
    let mut imps = Vec::new();
    for b in &bids {
        let mut imp = Map::new();
        imp.insert("id".into(), b["bidId"].clone());
        imp.insert("tagid".into(), json!(b["params"]["unit"].to_string().trim_matches('"')));
        if let Some(sizes) = b["mediaTypes"]["banner"]["sizes"].as_array() {
            let fmt: Vec<Value> = sizes.iter().map(|s| json!({"w": s[0], "h": s[1]})).collect();
            imp.insert("banner".into(), json!({ "format": fmt }));
        }
        if b["mediaTypes"]["video"].is_object() {
            let v = &b["mediaTypes"]["video"];
            imp.insert("video".into(), json!({"mimes": v["mimes"], "w": v["playerSize"][0][0], "h": v["playerSize"][0][1]}));
        }
        if let Some(f) = b["params"]["customFloor"].as_f64() {
            imp.insert("bidfloor".into(), json!(f));
            imp.insert("bidfloorcur".into(), json!("USD"));
        }
        imp.insert("ext".into(), json!({"divid": b["adUnitCode"]}));
        imps.push(Value::Object(imp));
    }
    let first = bids.get(0).cloned().unwrap_or(Value::Null);
    let mut req = match ortb2 { Value::Object(m) => m, _ => Map::new() };
    req.insert("id".into(), inp["bidderRequest"]["bidderRequestId"].clone());
    req.insert("imp".into(), Value::Array(imps));
    req.insert("cur".into(), json!(["USD"]));
    req.insert("ext".into(), json!({
        "bc": "pbjs_rs_0.1",
        "pv": inp["pbjsVersion"],
        "delDomain": first["params"]["delDomain"],
        "platform": first["params"]["platform"]
    }));
    if first["params"]["test"].as_bool() == Some(true) { req.insert("test".into(), json!(1)); }
    output(json!([{
        "method": "POST",
        "url": "https://rtb.openx.net/openrtbb/prebidjs",
        "data": Value::Object(req),
        "options": {"contentType": "application/json"}
    }]))
}

#[no_mangle]
pub extern "C" fn interpret_response(ptr: *const u8, len: usize) -> usize {
    let resp = input(ptr, len);
    let mut out = Vec::new();
    for sb in resp["body"]["seatbid"].as_array().into_iter().flatten() {
        for bid in sb["bid"].as_array().into_iter().flatten() {
            let mtype = match bid["mtype"].as_u64() { Some(2) => "video", Some(4) => "native", _ => "banner" };
            let mut b = json!({
                "requestId": bid["impid"], "cpm": bid["price"], "width": bid["w"], "height": bid["h"],
                "creativeId": bid["crid"], "dealId": bid["dealid"], "currency": resp["body"]["cur"].as_str().unwrap_or("USD"),
                "netRevenue": true, "ttl": 300, "mediaType": mtype,
                "meta": {"advertiserDomains": bid["adomain"], "networkId": bid["ext"]["dsp_id"], "brandId": bid["ext"]["brand_id"]}
            });
            if mtype == "video" { b["vastXml"] = bid["adm"].clone(); } else { b["ad"] = bid["adm"].clone(); }
            out.push(b);
        }
    }
    output(Value::Array(out))
}
