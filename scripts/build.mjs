import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
  // Electron is provided by the runtime; everything else is bundled.
  external: ['electron'],
};

await build({ ...shared, entryPoints: [join(root, 'src/main/index.ts')], outfile: join(dist, 'main/index.js') });
await build({ ...shared, entryPoints: [join(root, 'src/preload/splash.ts')], outfile: join(dist, 'preload/splash.js') });
await build({ ...shared, entryPoints: [join(root, 'src/preload/settings.ts')], outfile: join(dist, 'preload/settings.js') });
await build({ ...shared, entryPoints: [join(root, 'src/preload/chrome.ts')], outfile: join(dist, 'preload/chrome.js') });
await build({ ...shared, entryPoints: [join(root, 'src/preload/popover.ts')], outfile: join(dist, 'preload/popover.js') });
await build({ ...shared, entryPoints: [join(root, 'src/preload/update.ts')], outfile: join(dist, 'preload/update.js') });

for (const dir of ['splash', 'settings', 'chrome', 'popover', 'update']) {
  const from = join(root, 'src', dir);
  if (!existsSync(from)) continue;
  cpSync(from, join(dist, dir), { recursive: true });
}

await import('./generate-icons.mjs');
console.log('build: dist ready');
