//! PROTOTYPE: runs the transpiled Shared Adapters natively for harness/fuzz.mjs (TS vs Rust).
//! stdin, one call per line: `<bidder>\tmr\t<request json>` or `<bidder>\tmb\t<request json>\t<response json>`.
//! stdout, one JSON line per call, with the annotation slots decoded back to JSON.
use prebid_core_rt::{BidsOut, Doc, Reqs};
use std::io::{BufRead, Write};

fn esc(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}
fn rd_u32(b: &[u8], p: &mut usize) -> u32 {
    let n = u32::from_le_bytes(b[*p..*p + 4].try_into().unwrap());
    *p += 4;
    n
}
fn rd_bytes<'a>(b: &'a [u8], p: &mut usize) -> &'a [u8] {
    let n = rd_u32(b, p) as usize;
    let s = &b[*p..*p + n];
    *p += n;
    s
}
/// kv_slot frames -> JSON object (or null when empty)
fn kv(b: &[u8], out: &mut String) {
    if b.is_empty() {
        return out.push_str("null");
    }
    let mut p = 0;
    let n = rd_u32(b, &mut p);
    out.push('{');
    for i in 0..n {
        if i > 0 {
            out.push(',');
        }
        let k = std::str::from_utf8(rd_bytes(b, &mut p)).unwrap();
        esc(k, out);
        out.push(':');
        let kind = b[p];
        p += 1;
        let v = std::str::from_utf8(rd_bytes(b, &mut p)).unwrap();
        if kind == 0 { esc(v, out) } else { out.push_str(v) }
    }
    out.push('}');
}
fn json_or_null(b: &[u8], out: &mut String) {
    out.push_str(if b.is_empty() { "null" } else { std::str::from_utf8(b).unwrap() })
}
fn strs(v: &[String], out: &mut String) {
    out.push('[');
    for (i, s) in v.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        esc(s, out);
    }
    out.push(']');
}
fn req_out(r: Reqs) -> String {
    let mut o = String::from("{\"reqs\":[");
    for (i, (body, ids)) in r.reqs.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str("{\"body\":");
        o.push_str(std::str::from_utf8(body).unwrap());
        o.push_str(",\"impIDs\":");
        strs(ids, &mut o);
        o.push('}');
    }
    o.push_str("],\"errs\":");
    strs(&r.errs, &mut o);
    o.push('}');
    o
}
fn bids_out(r: BidsOut) -> String {
    let mut o = String::from("{\"bids\":[");
    for (i, b) in r.bids.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str(&format!("{{\"keep\":{},\"type\":", b.keep));
        esc(&b.typ, &mut o);
        o.push_str(",\"seat\":");
        esc(&b.seat, &mut o);
        o.push_str(&format!(",\"dealPriority\":{},\"video\":", b.deal_priority));
        kv(&b.video, &mut o);
        o.push_str(",\"meta\":");
        kv(&b.meta, &mut o);
        o.push_str(",\"overrides\":");
        json_or_null(&b.overrides, &mut o);
        o.push('}');
    }
    o.push_str("],\"currency\":");
    esc(&r.currency, &mut o);
    o.push_str(",\"paapi\":");
    json_or_null(&r.paapi, &mut o);
    o.push_str(",\"errs\":");
    strs(&r.errs, &mut o);
    o.push_str(&format!(",\"rejected\":{}", r.rejected));
    o.push('}');
    o
}

/// The native stand-in for the Host's functions: `{"now": ms, "rates": [[from, to, rate], ...]}`.
fn set_host(ctx: &str) {
    let mut d = Doc::new();
    let c = d.parse(ctx.as_bytes());
    let now = { let n = d.get(c, "now"); d.f64(n).unwrap_or(0.0) };
    let mut rates = Vec::new();
    let rs = d.get(c, "rates");
    for r in d.items(rs) {
        let (f, t, x) = (d.at(r, 0), d.at(r, 1), d.at(r, 2));
        if let (Some(f), Some(t), Some(x)) = (d.string(f).map(|s| s.into_owned()), d.string(t).map(|s| s.into_owned()), d.f64(x)) {
            rates.push((f, t, x));
        }
    }
    prebid_core_rt::set_host(now, rates);
}

fn main() {
    let mut d = Doc::new();
    let stdout = std::io::stdout();
    let mut w = std::io::BufWriter::new(stdout.lock());
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let f: Vec<&str> = line.split('\t').collect();
        d.reset();
        set_host(f[2]);
        let c = d.parse(f[2].as_bytes());
        let q = d.parse(f[3].as_bytes());
        type Mr = fn(&mut Doc, u32, u32) -> Reqs;
        type Mb = fn(&mut Doc, u32, u32, u32, u32) -> BidsOut;
        let (mr, mb): (Mr, Mb) = match f[0] {
            "openx" => (guest::openx::make_requests, guest::openx::make_bids),
            "pubmatic" => (guest::pubmatic::make_requests, guest::pubmatic::make_bids),
            _ => (guest::smaato::make_requests, guest::smaato::make_bids),
        };
        let out = if f[1] == "mr" {
            req_out(mr(&mut d, c, q))
        } else {
            let s = d.parse(f[4].as_bytes());
            let h = d.parse(f[5].as_bytes());
            bids_out(mb(&mut d, c, q, s, h))
        };
        writeln!(w, "{out}").unwrap();
    }
}
