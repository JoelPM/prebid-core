// PROTOTYPE: node transpiler/cli-typed1.mjs adapters/openx.ts [...] -> gen/rs-typed1/<bidder>.rs (server side)
import fs from 'node:fs';
import path from 'node:path';
import { transpileTyped1 } from './typed1.mjs';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
let bad = 0;
for (const f of process.argv.slice(2)) {
  const { rs, errors } = transpileTyped1(path.resolve(f), 'server');
  if (errors.length) { bad++; console.log(`REJECTED ${f}\n  ${errors.join('\n  ')}`); continue; }
  fs.mkdirSync(path.join(root, 'gen/rs-typed1'), { recursive: true });
  fs.writeFileSync(path.join(root, `gen/rs-typed1/${path.basename(f, '.ts')}.rs`), rs);
  console.log('transpiled (typed, Level 1)', f);
}
process.exitCode = bad ? 1 : 0;
