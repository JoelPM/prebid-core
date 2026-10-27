// PROTOTYPE transpiler CLI: node transpiler/cli.mjs adapters/openx.ts [...] -> gen/rs/<bidder>_server.rs
// Exits non-zero and prints every subset violation (file:line:col) if an Adapter is outside the subset.
import fs from 'node:fs';
import path from 'node:path';
import { transpile } from './transpile.mjs';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
let bad = 0;
for (const f of process.argv.slice(2)) {
  const { rs, errors } = transpile(path.resolve(f), 'server');
  if (errors.length) {
    bad++;
    console.log(`REJECTED ${f}\n  ${errors.join('\n  ')}`);
    continue;
  }
  const bidder = path.basename(f, '.ts');
  fs.mkdirSync(path.join(root, 'gen/rs'), { recursive: true });
  fs.writeFileSync(path.join(root, `gen/rs/${bidder}_server.rs`), rs);
  console.log('transpiled', f);
}
process.exitCode = bad ? 1 : 0;
