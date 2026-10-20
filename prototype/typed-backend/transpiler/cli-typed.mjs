// PROTOTYPE: node transpiler/cli-typed.mjs adapters/openx.ts [...] -> gen/rs-typed/<bidder>.rs (server side)
import fs from 'node:fs';
import path from 'node:path';
import { transpileTyped } from './typed.mjs';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
let bad = 0;
for (const f of process.argv.slice(2)) {
  const { rs, errors } = transpileTyped(path.resolve(f), 'server');
  if (errors.length) { bad++; console.log(`REJECTED ${f}\n  ${errors.join('\n  ')}`); continue; }
  fs.mkdirSync(path.join(root, 'gen/rs-typed'), { recursive: true });
  fs.writeFileSync(path.join(root, `gen/rs-typed/${path.basename(f, '.ts')}.rs`), rs);
  console.log('transpiled (typed)', f);
}
process.exitCode = bad ? 1 : 0;
