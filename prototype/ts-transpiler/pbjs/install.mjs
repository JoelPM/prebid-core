// PROTOTYPE: drops Prebid Core (TS Implementation + Host glue) and the Shared Adapters, as written,
// into a *scratch* Prebid.js clone: libraries/prebidCore, libraries/sharedAdapter and
// modules/{openx,pubmatic}SharedBidAdapter.ts. The Adapter source is copied verbatim; only import
// paths are rewritten and a footer registers its client side.
// Usage: node pbjs/install.mjs <prebid.js clone>
// NB: library dir names must not share a prefix (webpack.conf.js cacheGroup test is a prefix match).
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const P = process.argv[2];
const lib = path.join(P, 'libraries/prebidCore');
fs.mkdirSync(path.join(lib, 'params'), { recursive: true });
fs.mkdirSync(path.join(P, 'libraries/sharedAdapter'), { recursive: true });
const js = (s) => s.replace(/(from '[^']+)\.ts'/g, "$1.js'");
fs.writeFileSync(path.join(lib, 'index.ts'), js(fs.readFileSync(path.join(root, 'core/index.ts'), 'utf8')));
fs.copyFileSync(path.join(root, 'core/ortb.ts'), path.join(lib, 'ortb.ts'));
fs.copyFileSync(path.join(root, 'pbjs/sharedAdapter.ts'), path.join(P, 'libraries/sharedAdapter/sharedAdapter.ts'));

const handWritten = (f) => fs.readFileSync(path.join(P, 'modules', f), 'utf8');
const MODULES = {
  openx: {
    spec: `{ code: 'openx', gvlid: 69, supportedMediaTypes: [BANNER, VIDEO, NATIVE], getUserSyncs }`,
    context: `{ nativeRequest: { eventtrackers: [{ event: 1, methods: [1, 2] }] } }`,
    // non-translation code that stays in the module, copied verbatim from the Hand-written Adapter
    verbatim: () => {
      const s = handWritten('openxBidAdapter.js');
      return ["export const SYNC_URL = 'https://u.openx.net/w/1.0/pd';", "export const DEFAULT_PH = '2d1251ae-7f3a-47cf-bd2a-2f288854a0ba';",
        s.slice(s.indexOf('function getUserSyncs')).replace(/^function getUserSyncs\(([^)]*)\)/, 'function getUserSyncs($1: any)')].join('\n');
    },
  },
  pubmatic: {
    spec: `{ code: 'pubmatic', gvlid: 76, supportedMediaTypes: [BANNER, VIDEO, NATIVE] }`,
    context: `{}`,
    verbatim: () => '',
  },
};
for (const [bidder, mod] of Object.entries(MODULES)) {
  fs.writeFileSync(path.join(lib, `params/${bidder}.ts`), fs.readFileSync(path.join(root, `adapters/${bidder}.params.ts`), 'utf8').replace("'../core/ortb.ts'", "'../ortb.js'"));
  const src = fs.readFileSync(path.join(root, `adapters/${bidder}.ts`), 'utf8')
    .replace(/'\.\.\/core\/(index|ortb)\.ts'/g, "'../libraries/prebidCore/$1.js'")
    .replace(`'./${bidder}.params.ts'`, `'../libraries/prebidCore/params/${bidder}.js'`)
    .replace('export default defineAdapter', 'const def = defineAdapter');
  const out = `${src}
import { build } from '../libraries/prebidCore/index.js';
import { BANNER, NATIVE, VIDEO } from '../src/mediaTypes.js';
import { registerSharedAdapter } from '../libraries/sharedAdapter/sharedAdapter.js';
${mod.verbatim()}
registerSharedAdapter(${mod.spec}, build(def, 'client'), ${mod.context});
`;
  fs.writeFileSync(path.join(P, 'modules', `${bidder}SharedBidAdapter.ts`), out);
  console.log('wrote', `modules/${bidder}SharedBidAdapter.ts`);
}
