// PROTOTYPE Definition Compiler CLI: node compiler/cli.js defs/openx.yaml [...]
// Writes gen/ts/<bidder>.<side>.ts (and gen/rs/<bidder>_<side>.rs once the Rust back end exists).
import fs from 'node:fs';
import path from 'node:path';
import { load } from './def.js';
import { emitTs } from './emit-ts.js';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
let emitRs;
try { ({ emitRs } = await import('./emit-rs.js')); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
for (const f of process.argv.slice(2)) {
  const { sides } = load(f);
  for (const [side, m] of Object.entries(sides)) {
    fs.mkdirSync(path.join(root, 'gen/ts'), { recursive: true });
    fs.writeFileSync(path.join(root, `gen/ts/${m.bidder}.${side}.ts`), emitTs(m, '../../runtime/ts/core.ts'));
    if (emitRs) {
      fs.mkdirSync(path.join(root, 'gen/rs'), { recursive: true });
      fs.writeFileSync(path.join(root, `gen/rs/${m.bidder}_${side}.rs`), emitRs(m));
    }
  }
  console.log('compiled', f);
}
