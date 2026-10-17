//! Times the guest functions compiled natively (no WASM), to split "WASM codegen slowdown" from
//! "boundary + Host conversion" in the overhead. Usage: native <payload dir> <name>...
use guest::{split_bids_input, typed, value};
use std::hint::black_box;
use std::time::Instant;

fn bench(label: &str, mut f: impl FnMut()) {
    for _ in 0..20_000 { f(); }
    let n = 200_000;
    let t = Instant::now();
    for _ in 0..n { f(); }
    println!("{label:<44} {:8.2} us/op", t.elapsed().as_secs_f64() * 1e6 / n as f64);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    for name in &args[2..] {
        let rd = |s: &str| std::fs::read(format!("{}/{name}-{s}", args[1])).unwrap();
        let (req, resp, mbin) = (rd("req.json"), rd("resp.json"), rd("mb.bin"));
        let mut out = Vec::new();
        let mut run = |label: &str, f: &dyn Fn(&mut Vec<u8>)| bench(&format!("[{name}] native {label}"), || { out.clear(); f(&mut out); black_box(&out); });
        run("mr_value", &|o| value::make_requests(&req, o));
        run("mr_typed", &|o| typed::make_requests(&req, o));
        run("mb_value", &|o| { let (i, r) = split_bids_input(&mbin); value::make_bids(&i, r, o) });
        run("mb_typed_json", &|o| { let (i, r) = split_bids_input(&mbin); typed::make_bids_json(&i, r, o) });
        run("mb_typed_annot", &|o| { let (i, r) = split_bids_input(&mbin); typed::make_bids_annot(&i, r, o) });
        run("legacy adapt (value, #3 ABI)", &|o| o.extend(value::run_legacy(&req, &resp)));
        let _ = resp.len();
    }
}
