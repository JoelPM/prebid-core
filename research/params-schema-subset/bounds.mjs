// Checks the proposed bound rule: when a minimum/maximum has at most 15 significant digits, TS's plain f64
// `v <= b` gives the same verdict as comparing v's shortest decimal (what JSON.stringify writes, so what a
// server Host would hand the Rust validator) with b exactly. Also shows that the rule is needed.
// node bounds.mjs
const dec = s => { // exact decimal string -> [BigInt mantissa, exponent]
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s);
  const frac = m[3] ?? "";
  return [BigInt(m[1] + m[2] + frac), Number(m[4] ?? 0) - frac.length];
};
const cmp = (a, b) => { // exact compare of two decimal strings
  let [ma, ea] = dec(a), [mb, eb] = dec(b);
  if (ea > eb) ma *= 10n ** BigInt(ea - eb); else mb *= 10n ** BigInt(eb - ea);
  return ma < mb ? -1 : ma > mb ? 1 : 0;
};
const buf = new DataView(new ArrayBuffer(8));
const next = (x, d) => { buf.setFloat64(0, x); buf.setBigInt64(0, buf.getBigInt64(0) + BigInt(x >= 0 ? d : -d)); return buf.getFloat64(0); };
let seed = 7;
const rnd = n => (seed = (seed * 48271) % 2147483647) % n;
function run(digits, trials) {
  let diffs = 0, example = null;
  for (let t = 0; t < trials; t++) {
    const mant = String(1 + rnd(9)) + Array.from({ length: digits - 1 }, () => rnd(10)).join("");
    const b = `${rnd(2) ? "-" : ""}${mant}e${rnd(40) - 20 - digits}`;
    const bf = Number(b);
    for (const v of [bf, next(bf, 1), next(bf, -1), next(bf, 2), next(bf, -2)]) {
      const f64 = v <= bf, exact = cmp(String(v), b) <= 0;
      if (f64 !== exact) { diffs++; example ??= `maximum ${b}, value ${v}: f64 says ${f64}, exact says ${exact}`; }
    }
  }
  console.log(`bounds with ${digits} significant digits, ${trials} bounds x 5 neighbours: ${diffs} disagreements${example ? " e.g. " + example : ""}`);
}
for (const d of [1, 2, 6, 15, 16, 17]) run(d, 20000);
