import { rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('Make sure wrangler dev is stopped first!\n');

const targets = [
  join(root, '.wrangler', 'state', 'v3'),
  join(root, '.data'),
];

for (const dir of targets) {
  if (!existsSync(dir)) {
    console.log(`Skipping (not found): ${dir}`);
    continue;
  }
  console.log(`Removing ${dir}`);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    console.error(`  Failed — is wrangler dev still running?`);
    process.exit(1);
  }
}

console.log('\nDone. Restart your dev server to start fresh.');
