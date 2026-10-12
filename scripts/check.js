import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
for (const directory of ['src', 'bin', 'web', 'scripts', 'tests']) {
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.js')))
    execFileSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
}
for (const name of ['index', 'demo', 'workspace', 'docs', 'login']) {
  const html = readFileSync(`web/${name}.html`, 'utf8');
  if (!html.includes('BETA') || !html.includes('name="viewport"'))
    throw new Error(`Missing beta label or mobile viewport: ${name}`);
}
console.log('Source syntax, beta labels and page metadata passed.');
