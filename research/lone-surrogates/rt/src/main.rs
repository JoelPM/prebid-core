//! What the prototypes' Rust runtime (runtime/rs, `Doc`) does with each case in ../cases.tsv.
use prebid_core_rt::{Doc, V};

fn show(b: &[u8]) -> String {
    b.iter().map(|&c| if (0x20..0x7f).contains(&c) { (c as char).to_string() } else { format!("\\x{c:02x}") }).collect()
}
fn hexdoc(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}
fn wrap(content: &[u8]) -> Vec<u8> {
    [b"{\"s\":\"".as_slice(), content, b"\"}"].concat()
}
/// The content between {"s":" and "} of a case document.
fn content(doc: &[u8]) -> &[u8] {
    &doc[6..doc.len() - 2]
}
fn s_of(d: &mut Doc, doc: &[u8]) -> V {
    let r = d.parse(doc);
    d.get(r, "s")
}

fn main() {
    let cases: Vec<(String, Vec<u8>)> = std::fs::read_to_string("../cases.tsv").unwrap().lines()
        .map(|l| { let (n, h) = l.split_once('\t').unwrap(); (n.to_string(), hexdoc(h)) }).collect();
    let mut d = Doc::new();
    for (name, doc) in &cases {
        println!("== {name}  {}", show(doc));
        d.reset();
        let r = d.parse(doc);
        let s = d.get(r, "s");
        println!("  string()                 {}", show(d.string(s).unwrap().as_bytes()));
        println!("  emit (raw copy)          {}", show(&d.to_json(r)));
        let st = d.stringify(r);
        println!("  stringify (canonical)    {}", show(d.string(st).unwrap().as_bytes()));
        let n = d.len_js(s);
        println!("  .length                  {}", d.to_json(n).iter().map(|&b| b as char).collect::<String>());
        // trim on the case padded with spaces: does a rewritten string keep the surrogate?
        d.reset();
        let padded = wrap(&[b" ", content(doc), b" "].concat());
        let p = s_of(&mut d, &padded);
        let t = d.trim(p);
        let o = d.obj();
        d.set(o, "t", t);
        println!("  trim(\" x \") emitted      {}", show(&d.to_json(o)));
        // split on "A" and re-emit
        d.reset();
        let s = s_of(&mut d, doc);
        let sep = d.lit("A");
        let parts = d.split(s, sep);
        println!("  split(\"A\") emitted       {}", show(&d.to_json(parts)));
    }
    // equality and includes across cases
    let find = |n: &str| cases.iter().find(|(x, _)| x == n).unwrap().1.clone();
    println!("== comparisons (JS answer in brackets)");
    for (a, b, js) in [("hi", "lo", false), ("hi", "fffd_esc", false), ("lo", "fffd_esc", false), ("hi", "hi", true), ("pair_esc", "pair_lit", true), ("byte_ff", "byte_ff", true)] {
        d.reset();
        let x = s_of(&mut d, &find(a));
        let y = s_of(&mut d, &find(b));
        println!("  eq({a}, {b}) = {} [{js}]", d.eq(x, y));
    }
    for (a, b, js) in [("hi", "lo", false), ("hiA", "fffd_esc", false), ("rev", "hi", false)] {
        d.reset();
        let x = s_of(&mut d, &find(a));
        let y = s_of(&mut d, &find(b));
        let r = d.includes_js(x, y);
        println!("  includes({a}, {b}) = {} [{js}]", show(&d.to_json(r)));
    }
    // A string with an escape AND invalid UTF-8: unescape_utf16's from_utf8(..).unwrap_or("")
    println!("== escape + invalid UTF-8 in one string");
    d.reset();
    let s = s_of(&mut d, &wrap(b"x\\ny\xffz"));
    println!("  string() of \"x\\ny<ff>z\"   [{}]", show(d.string(s).unwrap().as_bytes()));
    let st = d.stringify(s);
    println!("  stringify                [{}]", show(d.string(st).unwrap().as_bytes()));
    // PubMatic native: out.adm = JSON.stringify(json(bid.adm).native)
    println!("== native adm re-serialization (PubMatic: stringify(json(adm).native))");
    for line in std::fs::read_to_string("../adm.tsv").unwrap().lines() {
        let (name, hex) = line.split_once('\t').unwrap();
        let doc = hexdoc(hex);
        d.reset();
        let r = d.parse(&doc);
        let adm = d.get(r, "adm");
        let nat = d.json(adm);
        let n = d.get(nat, "native");
        let st = d.stringify(n);
        let o = d.obj();
        d.set(o, "adm", st);
        println!("== adm {name}\n  in  {}\n  out {}", show(&doc), show(&d.to_json(o)));
    }
}
