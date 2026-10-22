//! Trusted Server probe: each case decoded the way Trusted Server decodes JSON, then re-encoded.
//!   typed: serde into trusted_server_openrtb::{BidResponse, BidRequest} (its OpenRTB model).
//!   value: serde_json::Value, which is how Trusted Server parses provider and PBS responses today
//!          (auction/provider.rs, integrations/prebid.rs).
//! Both read the bytes as Trusted Server does (serde_json::from_slice), so invalid UTF-8 and lone
//! surrogate escapes are errors, as in #23.
//! Usage: cargo run --release -- <cases dir>   (one JSON line per case; bodies base64)
use base64::Engine;
use serde_json::{json, Value};
use std::fs;

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn main() {
    let dir = std::env::args().nth(1).expect("cases dir");
    for kind in ["resp", "req"] {
        let mut files: Vec<_> = fs::read_dir(format!("{dir}/{kind}")).unwrap().map(|e| e.unwrap().path()).collect();
        files.sort();
        for f in files {
            let body = fs::read(&f).unwrap();
            let name = f.file_stem().unwrap().to_string_lossy().to_string();
            let mut out = json!({"case": name, "kind": kind});
            let typed = if kind == "resp" {
                serde_json::from_slice::<trusted_server_openrtb::BidResponse>(&body).map(|v| serde_json::to_vec(&v).unwrap())
            } else {
                serde_json::from_slice::<trusted_server_openrtb::BidRequest>(&body).map(|v| serde_json::to_vec(&v).unwrap())
            };
            match typed {
                Ok(b) => out["typed"] = json!(b64(&b)),
                Err(e) => out["typedErr"] = json!(e.to_string()),
            }
            match serde_json::from_slice::<Value>(&body) {
                Ok(v) => out["value"] = json!(b64(&serde_json::to_vec(&v).unwrap())),
                Err(e) => out["valueErr"] = json!(e.to_string()),
            }
            println!("{out}");
        }
    }
}
