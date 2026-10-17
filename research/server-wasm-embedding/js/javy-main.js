function readAll() {
  const chunks = []; let total = 0;
  const rd = (Javy.IO && Javy.IO.readSync) ? Javy.IO.readSync : Javy.readSync;
  for (;;) { const b = new Uint8Array(16384); const n = rd(0, b); if (n === 0) break; chunks.push(b.subarray(0, n)); total += n; }
  const all = new Uint8Array(total); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}
const out = new TextEncoder().encode(run(readAll()));
const wr = (Javy.IO && Javy.IO.writeSync) ? Javy.IO.writeSync : Javy.writeSync;
wr(1, out);
