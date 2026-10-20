// Runs the wasm build in V8 (not wazero: an indication only).
import { readFileSync } from 'node:fs';
const [wasmPath, dir] = process.argv.slice(2);
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath));
const x = instance.exports;
for (const f of ['lt-req.json', 'lt-resp.json', 'heavy-req.json', 'heavy-resp.json']) {
  const b = readFileSync(`${dir}/${f}`);
  new Uint8Array(x.memory.buffer, x.buf(), b.length).set(b);
  const n = 200000;
  let t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) x.w_valid(b.length);
  const v = Number(process.hrtime.bigint() - t) / n;
  t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) x.w_scan(b.length);
  const s = Number(process.hrtime.bigint() - t) / n;
  console.log(`wasm/V8 ${f.padEnd(16)} ${String(b.length).padStart(6)} B  from_utf8 ${v.toFixed(1).padStart(7)} ns  surrogate-escape scan ${s.toFixed(1).padStart(7)} ns`);
}
