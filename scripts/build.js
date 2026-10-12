import { rmSync, cpSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
cpSync('web', 'dist', { recursive: true });
console.log('Static beta website built in dist/.');
