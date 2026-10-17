import fs from 'fs';
const S = process.argv[2];
const te = new TextEncoder(), td = new TextDecoder();
const bytes = fs.readFileSync(S + '/wasm-adapter/openx_adapter.opt.wasm');
let t0 = performance.now();
const mod = await WebAssembly.compile(bytes); let t1 = performance.now();
const inst = await WebAssembly.instantiate(mod, {}); let t2 = performance.now();
const x = inst.exports;
const call = (fn, o) => { const b = te.encode(JSON.stringify(o)); const p = x.alloc(b.length); new Uint8Array(x.memory.buffer, p, b.length).set(b); const r = x[fn](p, b.length); x.dealloc(p, b.length); return r; };
const get = () => JSON.parse(td.decode(new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len())));
const bid = { bidId: 'b1', adUnitCode: 'div-1', params: { unit: 12345, delDomain: 'pub-d.openx.net' }, mediaTypes: { banner: { sizes: [[300,250],[728,90]] } } };
console.log('valid', call('is_bid_request_valid', bid));
let t3 = performance.now(); call('build_requests', { bidRequests: [bid, bid, bid], bidderRequest: { bidderRequestId: 'r1', ortb2: { site: { page: 'https://x' } } }, pbjsVersion: '11.0' }); const req = get(); let t4 = performance.now();
call('interpret_response', { body: { cur: 'USD', seatbid: [{ bid: [{ impid: 'b1', price: 1.2, w: 300, h: 250, crid: 'c', adm: '<div/>', mtype: 1, adomain: ['a.com'], ext: {} }] }] } }); const bids = get();
console.log(JSON.stringify(req).slice(0, 200)); console.log(JSON.stringify(bids));
console.log(`rust wasm compile ${(t1-t0).toFixed(2)}ms instantiate ${(t2-t1).toFixed(2)}ms first buildRequests ${(t4-t3).toFixed(3)}ms`);
let N=10000, a=performance.now(); for (let i=0;i<N;i++){ call('build_requests', { bidRequests: [bid], bidderRequest: { bidderRequestId: 'r1', ortb2: {} } }); get(); } console.log('rust buildRequests avg us', ((performance.now()-a)/N*1000).toFixed(1));
// quickjs
const { newQuickJSWASMModuleFromVariant } = await import(S + '/qjs/node_modules/quickjs-emscripten-core/dist/index.mjs');
const variant = (await import(S + '/qjs/node_modules/@jitl/quickjs-wasmfile-release-sync/dist/index.mjs')).default;
let q0 = performance.now(); const qjs = await newQuickJSWASMModuleFromVariant(variant); let q1 = performance.now(); const vm = qjs.newContext(); let q2 = performance.now();
vm.unwrapResult(vm.evalCode(`globalThis.build = (s) => { const i = JSON.parse(s); return JSON.stringify({method:'POST', url:'https://rtb.openx.net/openrtbb/prebidjs', data:{id:i.bidderRequest.bidderRequestId, imp:i.bidRequests.map(b=>({id:b.bidId, tagid:String(b.params.unit), banner:{format:b.mediaTypes.banner.sizes.map(([w,h])=>({w,h}))}, ext:{divid:b.adUnitCode}}))}}); }`)).dispose();
let q3 = performance.now();
const inp = JSON.stringify({ bidRequests: [bid], bidderRequest: { bidderRequestId: 'r1', ortb2: {} } });
let M=10000, b0=performance.now(); for (let i=0;i<M;i++){ const h = vm.newString(inp); const f = vm.getProp(vm.global, 'build'); const r = vm.unwrapResult(vm.callFunction(f, vm.undefined, h)); vm.getString(r); r.dispose(); f.dispose(); h.dispose(); } const b1=performance.now();
console.log(`quickjs module load+instantiate ${(q1-q0).toFixed(2)}ms newContext ${(q2-q1).toFixed(2)}ms eval adapter ${(q3-q2).toFixed(2)}ms buildRequests avg us ${((b1-b0)/M*1000).toFixed(1)}`);
// native JS for reference
const build = (s) => { const i = JSON.parse(s); return JSON.stringify({method:'POST', data:{imp:i.bidRequests.map(b=>({id:b.bidId, tagid:String(b.params.unit), banner:{format:b.mediaTypes.banner.sizes.map(([w,h])=>({w,h}))}}))}}); };
let n0=performance.now(); for (let i=0;i<M;i++) build(inp); console.log('native JS buildRequests avg us', ((performance.now()-n0)/M*1000).toFixed(2));
