// אורז את ממשק Material Design 3 (Material Web + מחולל צבעים) לקובץ אחד שרץ בלי רשת ובלי node_modules.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [path.join(root, 'src/renderer/js/main.js')],
  outfile: path.join(root, 'src/renderer/ui.bundle.js'),
  bundle: true, minify: true, format: 'iife', target: 'chrome120', legalComments: 'none', logLevel: 'info'
});
