use std::time::Instant;
fn main() {
    let req = std::fs::read("../payload/req.json").unwrap();
    let resp = std::fs::read("../payload/resp.json").unwrap();
    std::fs::write("../out-rs-native.json", guestrs::run(&req, &resp)).unwrap();
    for _ in 0..20000 { std::hint::black_box(guestrs::run(&req, &resp)); }
    let n = 100000; let t = Instant::now();
    for _ in 0..n { std::hint::black_box(guestrs::run(&req, &resp)); }
    println!("native Rust (serde_json::Value) OpenX port: {:.1} us/op", t.elapsed().as_secs_f64() * 1e6 / n as f64);
}
