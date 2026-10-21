import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'host');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, 'packages/native-host/src/main.ts')],
  outfile: path.join(outDir, 'viddock-host.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  legalComments: 'none',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'module', name: 'viddock-host' }, null, 2));
console.log('native host built ->', path.relative(root, outDir));
