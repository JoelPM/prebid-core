// PROTOTYPE: drops Prebid Core (TS runtime + Host glue) and the generated Client-side Shared Adapters
// into a *scratch* Prebid.js clone as libraries/prebidCore, libraries/sharedAdapter and
// modules/{openx,pubmatic}SharedBidAdapter.ts.
// Usage: node pbjs/install.mjs <prebid.js clone>
// NB: library dir names must not share a prefix (webpack.conf.js cacheGroup test is a prefix match).
import fs from 'node:fs';
import path from 'node:path';
import { load } from '../compiler/def.js';
import { emitTs } from '../compiler/emit-ts.js';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const P = process.argv[2];
fs.mkdirSync(path.join(P, 'libraries/prebidCore'), { recursive: true });
fs.mkdirSync(path.join(P, 'libraries/sharedAdapter'), { recursive: true });
fs.copyFileSync(path.join(root, 'runtime/ts/core.ts'), path.join(P, 'libraries/prebidCore/core.ts'));
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
  const { sides } = load(path.join(root, 'defs', `${bidder}.yaml`));
  const gen = emitTs(sides.client, '../libraries/prebidCore/core.js');
  const out = `${gen}
import { BANNER, NATIVE, VIDEO } from '../src/mediaTypes.js';
import { registerSharedAdapter } from '../libraries/sharedAdapter/sharedAdapter.js';
${mod.verbatim()}
registerSharedAdapter(${mod.spec}, { makeRequests, makeBids, isValid, endpoint }, ${mod.context});
`;
  fs.writeFileSync(path.join(P, 'modules', `${bidder}SharedBidAdapter.ts`), out);
  console.log('wrote', `modules/${bidder}SharedBidAdapter.ts`);
}
