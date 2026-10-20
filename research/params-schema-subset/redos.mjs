// Times feedad's catalogue pattern on "a"×n + "!" in V8 (Redos.java does Java), next to a star-height-1
// rewrite that accepts the same language. Go RE2 and Rust regex guarantee linear time, so they are not timed.
const feedad = new RegExp("^(([a-z0-9])+[-_]?)+$", "u");
const rewrite = new RegExp("^([a-z0-9]|[a-z0-9][-_])+$", "u");
for (const n of [16, 20, 22, 24, 26]) {
  const s = "a".repeat(n) + "!";
  const t = performance.now(); feedad.test(s);
  const t1 = performance.now(); rewrite.test(s);
  console.log(`node n=${n}: feedad ${(t1 - t).toFixed(1)} ms, rewrite ${(performance.now() - t1).toFixed(2)} ms`);
}
const big = "a".repeat(100000) + "!";
const t = performance.now(); rewrite.test(big);
console.log(`node n=100000: rewrite ${(performance.now() - t).toFixed(1)} ms`);
// same language on short strings
const alphabet = ["a", "0", "-", "_", "!"];
let diffs = 0;
const all = (len, pre = "") => len === 0 ? [pre] : alphabet.flatMap(c => all(len - 1, pre + c));
for (let len = 0; len <= 7; len++) for (const s of all(len)) if (feedad.test(s) !== rewrite.test(s)) diffs++;
console.log(`feedad vs rewrite on every string of length <= 7 over {a,0,-,_,!}: ${diffs} differences`);
