const bl = require(process.cwd()+'/node_modules/browserslist');
const lite = require(process.cwd()+'/node_modules/caniuse-lite');
const list = bl(undefined, {path: process.cwd()});
const feats = ['wasm','wasm-bulk-memory','wasm-multi-value','wasm-reference-types','wasm-signext','wasm-nontrapping-fptoint','wasm-bigint','wasm-mutable-globals','wasm-simd','wasm-threads'];
for (const f of feats) {
  let d; try { d = lite.feature(require(process.cwd()+'/node_modules/caniuse-lite/data/features/'+f+'.js')); } catch(e) { console.log(f,'n/a'); continue; }
  const no = list.filter(b => { const [n,v] = b.split(' '); const s = (d.stats[n]||{})[v] || (d.stats[n]||{})[v.split('-')[0]]; return !s || !s.startsWith('y'); });
  console.log(f.padEnd(26), 'unsupported in:', no.join(', ') || '(none)');
}
