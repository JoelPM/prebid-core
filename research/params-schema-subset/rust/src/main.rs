// Rust `regex` engine as a generated Rust validator would call it: Regex::new(p)?.is_match(s).
// cargo run --release -- ../cases.json > ../out/rust.json
use regex::Regex;
use serde_json::{json, Map, Value};

fn main() {
    let path = std::env::args().nth(1).expect("cases.json");
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let strings: Vec<&str> = cases["strings"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
    let mut out = Map::new();
    for group in ["catalogue", "probes"] {
        for p in cases[group].as_array().unwrap() {
            let p = p.as_str().unwrap();
            let r = match Regex::new(p) {
                Err(e) => json!({ "error": e.to_string().lines().last().unwrap_or("").trim() }),
                Ok(re) => json!({ "m": strings.iter().map(|s| if re.is_match(s) { '1' } else { '0' }).collect::<String>() }),
            };
            out.insert(p.to_string(), r);
        }
    }
    println!("{}", json!({ "engine": "rust regex 1.11.1", "results": out }));
}
