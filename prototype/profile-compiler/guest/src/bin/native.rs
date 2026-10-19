//! Times the generated Shared Adapters natively (no wasm) on hostgo's payloads, per phase.
//! Usage: cargo run --release --bin native -- ../out/payload
use std::time::Instant;
use prebid_core_rt::Doc;

fn time<F: FnMut()>(label: &str, mut f: F) {
    for _ in 0..2000 { f(); }
    let mut best = f64::MAX;
    for _ in 0..5 {
        let n = 20000;
        let t = Instant::now();
        for _ in 0..n { f(); }
        best = best.min(t.elapsed().as_secs_f64() * 1e6 / n as f64);
    }
    println!("  {label:<40} {best:7.2} us");
}

fn main() {
    let dir = std::env::args().nth(1).unwrap();
    let mut d = Doc::new();
    if let Some(secs) = std::env::args().nth(2) {
        // profiling loop: pubmatic lt make_requests for <secs>
        let req = std::fs::read(format!("{dir}/pubmatic-lt-req.json")).unwrap();
        let end = Instant::now() + std::time::Duration::from_secs(secs.parse().unwrap());
        while Instant::now() < end {
            for _ in 0..1000 { d.reset(); let r = d.parse(&req); std::hint::black_box(guest::frame_req(guest::pubmatic::make_requests(&mut d, r))); }
        }
        return;
    }
    for b in ["openx", "pubmatic"] {
        for name in ["lt", "heavy"] {
            let rd = |s: &str| std::fs::read(format!("{dir}/{b}-{name}-{s}.json")).unwrap();
            let (req, out, resp) = (rd("req"), rd("out"), rd("resp"));
            println!("{b} / {name}");
            let (mr, mb): (fn(&mut Doc, u32) -> prebid_core_rt::ReqOut, fn(&mut Doc, u32, u32) -> prebid_core_rt::BidsOut) = match b {
                "openx" => (guest::openx::make_requests, guest::openx::make_bids),
                _ => (guest::pubmatic::make_requests, guest::pubmatic::make_bids),
            };
            time("parse+skim request only", || { d.reset(); let r = d.parse(&req); let i = d.get(r, "imp"); std::hint::black_box(d.items(i)); });
            time("make_requests (incl. parse, emit)", || { d.reset(); let r = d.parse(&req); std::hint::black_box(guest::frame_req(mr(&mut d, r))); });
            time("make_bids (incl. parse)", || { d.reset(); let q = d.parse(&out); let s = d.parse(&resp); std::hint::black_box(guest::frame_bids(mb(&mut d, q, s))); });
        }
    }
}
