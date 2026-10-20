// What a Rust validator built on serde_json's default Value would be handed for each values.json instance.
// cargo run --release --bin values -- ../values.json > ../out/values-rust.json
use serde_json::{json, Map, Value};

fn main() {
    let path = std::env::args().nth(1).expect("values.json");
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut out = Map::new();
    for c in cases.as_array().unwrap() {
        let res: Vec<String> = c["instances"].as_array().unwrap().iter().map(|raw| {
            match serde_json::from_str::<Value>(raw.as_str().unwrap()) {
                Err(e) => format!("parse error: {e}"),
                Ok(Value::Number(n)) => format!("number {n} i64={:?} u64={:?} f64={:?}", n.as_i64(), n.as_u64(), n.as_f64()),
                Ok(Value::String(s)) => format!("string bytes={} chars={}", s.len(), s.chars().count()),
                Ok(v) => format!("{v}"),
            }
        }).collect();
        out.insert(c["name"].as_str().unwrap().to_string(), json!(res));
    }
    println!("{}", Value::Object(out));
}
