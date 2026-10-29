// Copies third-party browser files from node_modules into www/vendor so the
// game runs with no network: in the Android app, and when index.html is
// opened straight from disk. Run `npm run vendor` after upgrading a package.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const files = {
  'node_modules/matter-js/build/matter.min.js': 'www/vendor/matter.min.js',
  'node_modules/@capacitor/core/dist/capacitor.js': 'www/vendor/capacitor.js',
  'node_modules/@capacitor/app/dist/plugin.js': 'www/vendor/capacitor-app.js',
  'node_modules/@fontsource-variable/fredoka/files/fredoka-latin-wght-normal.woff2':
    'www/vendor/fonts/fredoka-latin.woff2',
  'node_modules/@fontsource-variable/fredoka/files/fredoka-latin-ext-wght-normal.woff2':
    'www/vendor/fonts/fredoka-latin-ext.woff2',
  'node_modules/@fontsource-variable/fredoka/LICENSE': 'www/vendor/fonts/OFL.txt',
};

for (const [from, to] of Object.entries(files)) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`${from} -> ${to}`);
}
