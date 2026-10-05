import { build } from 'vite';
import { mkdir, copyFile } from 'node:fs/promises';

await build();
for (const entry of ['background', 'content', 'pot']) {
  await build({
    configFile: false,
    publicDir: false,
    build: {
      target: 'firefox140', emptyOutDir: false,
      lib: { entry: `src/${entry}.ts`, name: entry, formats: ['iife'], fileName: () => `${entry}.js` },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}
await mkdir('dist', { recursive: true });
await copyFile('manifest.json', 'dist/manifest.json');
await mkdir('dist/licenses', { recursive: true });
await copyFile('node_modules/hls.js/LICENSE', 'dist/licenses/hls.js-LICENSE.txt');
await copyFile('node_modules/dashjs/LICENSE.md', 'dist/licenses/dash.js-LICENSE.txt');
