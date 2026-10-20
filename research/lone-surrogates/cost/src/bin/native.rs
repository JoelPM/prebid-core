use std::hint::black_box;
use std::time::Instant;
use surrogates_cost::{surrogate_escapes, valid};

fn main() {
    let dir = std::env::args().nth(1).expect("payload dir");
    for f in ["lt-req.json", "lt-resp.json", "heavy-req.json", "heavy-resp.json"] {
        let b = std::fs::read(format!("{dir}/{f}")).unwrap();
        let n = 200_000;
        let t = Instant::now();
        for _ in 0..n {
            black_box(valid(black_box(&b)));
        }
        let v = t.elapsed().as_nanos() as f64 / n as f64;
        let t = Instant::now();
        for _ in 0..n {
            black_box(surrogate_escapes(black_box(&b)));
        }
        let s = t.elapsed().as_nanos() as f64 / n as f64;
        println!("native  {f:16} {:6} B  from_utf8 {:7.1} ns  surrogate-escape scan {:7.1} ns", b.len(), v, s);
    }
}
