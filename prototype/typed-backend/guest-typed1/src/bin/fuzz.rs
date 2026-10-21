//! PROTOTYPE: runs the typed guest natively for harness/fuzz.mjs (TS vs Rust), through the same
//! frames the Host reads. stdin, one call per line: `<bidder>\tmr\t<request>` or
//! `<bidder>\tmb\t<request>\t<response>`; stdout, one JSON line per call (same format as guest/'s fuzz bin).
use std::io::{BufRead, Write};

struct R<'a>(&'a [u8], usize);
impl<'a> R<'a> {
    fn u32(&mut self) -> u32 {
        let n = u32::from_le_bytes(self.0[self.1..self.1 + 4].try_into().unwrap());
        self.1 += 4;
        n
    }
    fn bytes(&mut self) -> &'a [u8] {
        let n = self.u32() as usize;
        let s = &self.0[self.1..self.1 + n];
        self.1 += n;
        s
    }
}
fn esc(s: &[u8], o: &mut String) {
    o.push('"');
    for c in String::from_utf8_lossy(s).chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
}
fn json(b: &[u8], o: &mut String) {
    o.push_str(if b.is_empty() { "null" } else { std::str::from_utf8(b).unwrap() })
}
fn kv(b: &[u8], o: &mut String) {
    if b.is_empty() {
        return o.push_str("null");
    }
    let mut r = R(b, 0);
    let n = r.u32();
    o.push('{');
    for i in 0..n {
        if i > 0 {
            o.push(',');
        }
        esc(r.bytes(), o);
        o.push(':');
        let kind = r.0[r.1];
        r.1 += 1;
        let v = r.bytes();
        if kind == 0 { esc(v, o) } else { o.push_str(std::str::from_utf8(v).unwrap()) }
    }
    o.push('}');
}
fn strs(r: &mut R, o: &mut String) {
    let n = r.u32();
    o.push('[');
    for i in 0..n {
        if i > 0 {
            o.push(',');
        }
        esc(r.bytes(), o);
    }
    o.push(']');
}
fn req_out(f: &[u8]) -> String {
    let mut r = R(f, 0);
    let mut o = String::from("{\"body\":");
    if r.u32() == 1 {
        json(r.bytes(), &mut o)
    } else {
        o.push_str("null")
    }
    o.push_str(",\"impIDs\":");
    strs(&mut r, &mut o);
    o.push_str(",\"errs\":");
    strs(&mut r, &mut o);
    o.push('}');
    o
}
fn bids_out(f: &[u8]) -> String {
    let mut r = R(f, 0);
    let n = r.u32();
    let mut o = String::from("{\"bids\":[");
    for i in 0..n {
        if i > 0 {
            o.push(',');
        }
        let keep = r.u32() == 1;
        o.push_str(&format!("{{\"keep\":{keep},\"type\":"));
        esc(r.bytes(), &mut o);
        o.push_str(",\"seat\":");
        esc(r.bytes(), &mut o);
        o.push_str(&format!(",\"dealPriority\":{},\"video\":", r.u32() as i32));
        kv(r.bytes(), &mut o);
        o.push_str(",\"meta\":");
        kv(r.bytes(), &mut o);
        o.push_str(",\"overrides\":");
        json(r.bytes(), &mut o);
        o.push('}');
    }
    o.push_str("],\"currency\":");
    esc(r.bytes(), &mut o);
    o.push_str(",\"paapi\":");
    json(r.bytes(), &mut o);
    o.push_str(",\"errs\":");
    strs(&mut r, &mut o);
    o.push('}');
    o
}

fn main() {
    let stdout = std::io::stdout();
    let mut w = std::io::BufWriter::new(stdout.lock());
    let mut out = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let f: Vec<&str> = line.split('\t').collect();
        out.clear();
        let s = match (f[0], f[1]) {
            ("openx", "mr") => { guest_typed1::openx::make_requests(f[2].as_bytes(), &mut out); req_out(&out) }
            ("pubmatic", "mr") => { guest_typed1::pubmatic::make_requests(f[2].as_bytes(), &mut out); req_out(&out) }
            ("openx", _) => { guest_typed1::openx::make_bids(f[2].as_bytes(), f[3].as_bytes(), &mut out); bids_out(&out) }
            (_, _) => { guest_typed1::pubmatic::make_bids(f[2].as_bytes(), f[3].as_bytes(), &mut out); bids_out(&out) }
        };
        writeln!(w, "{s}").unwrap();
    }
}
