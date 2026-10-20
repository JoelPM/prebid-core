//! What serde_json (Trusted Server's JSON layer, 1.0.150 as in its Cargo.lock) does with each case
//! in ../cases.tsv.
use serde::Deserialize;
use serde_json::value::RawValue;

#[derive(Deserialize)]
struct S {
    s: String,
}
#[derive(Deserialize)]
struct B {
    #[serde(with = "serde_bytes")]
    s: Vec<u8>,
}
#[derive(Deserialize)]
struct R<'a> {
    #[serde(borrow)]
    s: &'a RawValue,
}

fn show(b: &[u8]) -> String {
    b.iter().map(|&c| if (0x20..0x7f).contains(&c) { (c as char).to_string() } else { format!("\\x{c:02x}") }).collect()
}

/// A typed back end on serde_json: bid.adm as String, then serde_json::to_string(&json(adm)["native"]).
fn adm() {
    for line in std::fs::read_to_string("../adm.tsv").unwrap().lines() {
        let (name, hex) = line.split_once('\t').unwrap();
        let doc: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        let r = serde_json::from_slice::<serde_json::Value>(&doc).and_then(|bid| {
            let nat: serde_json::Value = serde_json::from_str(bid["adm"].as_str().unwrap())?;
            serde_json::to_vec(&serde_json::json!({ "adm": serde_json::to_string(&nat["native"])? }))
        });
        match r {
            Ok(out) => println!("== adm {name}\n  in  {}\n  out {}", show(&doc), show(&out)),
            Err(e) => println!("== adm {name}\n  in  {}\n  ERR {e}", show(&doc)),
        }
    }
}

fn main() {
    adm();
    let cases = std::fs::read_to_string("../cases.tsv").unwrap();
    for line in cases.lines() {
        let (name, hex) = line.split_once('\t').unwrap();
        let doc: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        println!("== {name}  {}", show(&doc));
        match serde_json::from_slice::<serde_json::Value>(&doc) {
            Ok(v) => println!("  from_slice::<Value>       {} -> to_vec {}", show(v["s"].as_str().unwrap().as_bytes()), show(&serde_json::to_vec(&v).unwrap())),
            Err(e) => println!("  from_slice::<Value>       ERR {e}"),
        }
        match serde_json::from_slice::<S>(&doc) {
            Ok(v) => println!("  from_slice::<struct>      {}", show(v.s.as_bytes())),
            Err(e) => println!("  from_slice::<struct>      ERR {e}"),
        }
        match std::str::from_utf8(&doc) {
            Ok(t) => println!("  str::from_utf8            ok ({} bytes)", t.len()),
            Err(e) => println!("  str::from_utf8            ERR {e}"),
        }
        match serde_json::from_slice::<R>(&doc) {
            Ok(v) => println!("  &RawValue                 {}", show(v.s.get().as_bytes())),
            Err(e) => println!("  &RawValue                 ERR {e}"),
        }
        match serde_json::from_slice::<B>(&doc) {
            Ok(v) => println!("  bytes (serde_bytes)       {} {}", show(&v.s), if std::str::from_utf8(&v.s).is_ok() { "" } else { "(not UTF-8: WTF-8/raw)" }),
            Err(e) => println!("  bytes (serde_bytes)       ERR {e}"),
        }
        match serde_json::from_slice::<serde::de::IgnoredAny>(&doc) {
            Ok(_) => println!("  IgnoredAny (skip)         ok"),
            Err(e) => println!("  IgnoredAny (skip)         ERR {e}"),
        }
    }
}
