import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlFiles = ['public/index.html', 'public/REJA-standalone.html', 'public/market.html'];
const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
let checked = 0;
for (const relativePath of htmlFiles) {
  const html = await fs.readFile(path.join(root, relativePath), 'utf8');
  let match;
  let found = 0;
  scriptPattern.lastIndex = 0;
  while ((match = scriptPattern.exec(html))) {
    const attrs = match[1].toLowerCase();
    if (/type=["']application\/json["']/.test(attrs) || /\bsrc=/.test(attrs)) continue;
    new vm.Script(match[2], { filename: `${relativePath}#inline-script-${found + 1}` });
    found += 1;
  }
  if (found === 0) throw new Error(`${relativePath} contains no inline JavaScript to validate.`);
  checked += found;
  console.log(`checked ${relativePath}: ${found} inline JavaScript block(s)`);
}
console.log(`frontend syntax valid: ${checked} inline JavaScript block(s)`);
