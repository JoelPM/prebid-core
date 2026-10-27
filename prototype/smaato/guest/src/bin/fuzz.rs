//! PROTOTYPE: runs the transpiled Shared Adapters natively for harness/fuzz.mjs (TS vs Rust).
//! stdin, one call per line: `<bidder>\tmr\t<request json>` or `<bidder>\tmb\t<request json>\t<response json>`.
//! stdout, one JSON line per call, with the annotation slots decoded back to JSON.
use prebid_core_rt::{BidsOut, Doc, ReqOut};
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
fn req_out(r: ReqOut) -> String {
    let mut o = String::from("{\"body\":");
    match &r.body {
        Some(b) => o.push_str(std::str::from_utf8(b).unwrap()),
        None => o.push_str("null"),
    }
    o.push_str(",\"impIDs\":");
    strs(&r.imp_ids, &mut o);
    o.push_str(",\"errs\":");
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
    o.push('}');
    o
}

fn main() {
    let mut d = Doc::new();
    let stdout = std::io::stdout();
    let mut w = std::io::BufWriter::new(stdout.lock());
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let f: Vec<&str> = line.split('\t').collect();
        d.reset();
        let out = match (f[0], f[1]) {
            ("openx", "mr") => { let r = d.parse(f[2].as_bytes()); req_out(guest::openx::make_requests(&mut d, r)) }
            ("pubmatic", "mr") => { let r = d.parse(f[2].as_bytes()); req_out(guest::pubmatic::make_requests(&mut d, r)) }
            ("openx", "mb") => { let q = d.parse(f[2].as_bytes()); let s = d.parse(f[3].as_bytes()); bids_out(guest::openx::make_bids(&mut d, q, s)) }
            (_, _) => { let q = d.parse(f[2].as_bytes()); let s = d.parse(f[3].as_bytes()); bids_out(guest::pubmatic::make_bids(&mut d, q, s)) }
        };
        writeln!(w, "{out}").unwrap();
    }
}
