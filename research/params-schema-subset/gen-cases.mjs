// Writes cases.json: the catalogue's distinct patterns, feature probes, and adversarial strings.
// node gen-cases.mjs <catalogue.json from catalogue.py --json> > cases.json
import fs from "node:fs";
const cat = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const catalogue = [...new Set([...cat.go.patterns, ...cat.java.patterns].map(p => p[2]))];
const probes = [
  "^\\d+$", "^\\w+$", "^\\s$", "^\\S+$", "^.$", "^.+$", "^.{2}$", "^[^a]$", "\\bfoo\\b",
  "(?i)^k$", "(?i)^s$", "^\\p{L}+$", "^\\p{Lu}$", "^[[:digit:]]+$", "^\\x41$", "^\\u0041$", "^\\x{41}$",
  "^\\/$", "^\\_$", "^[\\-a]+$", "^\\cJ$", "a(?=b)", "(?<!a)b", "(a)\\1", "^a*+$", "^a{2,}+$",
  "(?<n>a)", "(?P<n>a)", "\\Aabc", "abc\\z", "abc\\Z", "[a-z&&[^b]]", "^\\h$", "^\\v$",
  "^[0-9]{1001}$", "^$", "^a|b$", "^([a-z0-9]|[a-z0-9][-_])+$","[]a]", "[^]a]", "a{,3}", "a{2", "\\Q.\\E", "^\\X$", "^\\R$",
];
const strings = [
  "", "123", "123\n", "\n123", "123\r", "123\r\n", "١٢٣", "１２３", "12³",
  "a.openx.net", "a.openx.net\n", "openx", "a.b", "a\r.b", "a\n.b", "a .b", "a\u0085.b",
  "é", "é", "😀", "😀😀", "ſ", "K", "K", "k", "s", "S",
  " ", "\u000b", "\u000c", "﻿", " ", "᠎", " ", "\t", "a b", "abc_def", "ÄÖ", "²",
  "x-1-2", "abc-123-456", "-abc", "_x", "a", "b", "ab", "A", "/", "_", "-", "\n", "\r", "foo", "a foo b", "éfoo",
  "0123456789abcdef", "0123456789ABCDEF", "0123|56789abcdef", "0123456789abcdeFé",
  "8db4a3b2-3d24-4f71-9c34-6a5b6c3d2e10", "8DB4A3B2-3D24-4F71-9C34-6A5B6C3D2E10",
  "1.5", "01", "1e5", "0", "1.", ".5", "1..5", "gross", "net", "grossnet", "abc", "abcd", "xabc",
  "http://a.b:80", "https://a.b", "ftp://a.b", "a.b:80", "a.b:", "host_name.com", "-a.com", "a-.com",
  "aaaa-bbbb", "aaaa--bbbb", "a".repeat(63), "a".repeat(64), "0".repeat(1001),
];
// seeded fuzz: random strings over a hostile alphabet (ASCII, line terminators, Unicode digits/spaces/letters, emoji)
let seed = 22;
const rnd = n => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
const alphabet = [..."aZz09_-.:/|!@ ", "\n", "\r", "\t", "\u000b", "\u000c", "\u0085", "\u00a0", "\u2028", "\u2029", "\ufeff",
  "\u0661", "\uff11", "\u00e9", "\u017f", "\u212a", "\u2003", "\ud83d\ude00", "a.openx.net", "123", "http://", "8db4a3b2-3d24-"];
for (let k = 0; k < 3000; k++) strings.push(Array.from({ length: rnd(10) }, () => alphabet[rnd(alphabet.length)]).join(""));
console.log(JSON.stringify({ catalogue, probes, strings }, null, 1));
