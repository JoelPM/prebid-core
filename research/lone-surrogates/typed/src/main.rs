//! What the typed guest's string helpers (typed/src/j.rs) do with each case in ../cases.tsv.
use typed_guest::j::{self, JStr, P, W};

fn show(b: &[u8]) -> String {
    b.iter().map(|&c| if (0x20..0x7f).contains(&c) { (c as char).to_string() } else { format!("\\x{c:02x}") }).collect()
}

fn main() {
    for line in std::fs::read_to_string("../cases.tsv").unwrap().lines() {
        let (name, hex) = line.split_once('\t').unwrap();
        let doc: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        println!("== {name}  {}", show(&doc));
        let mut got: Option<JStr> = None;
        P::new(&doc).obj(|p, _k| got = p.str());
        let s = got.unwrap();
        let mut out = Vec::new();
        W { b: &mut out }.jstr(s);
        println!("  W::jstr (raw copy)        {}", show(&out));
        let c = s.cow();
        println!("  JStr::cow                 {}", show(c.as_bytes()));
        let mut out = Vec::new();
        W { b: &mut out }.str_(&j::trim(&c));
        println!("  trim -> W::str_           {}", show(&out));
        println!("  split('A').nth(0)         {}", show(j::split(Some(&c), 'A').nth(0).unwrap_or("").as_bytes()));
    }
}
