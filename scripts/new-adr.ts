#!/usr/bin/env tsx
/** Scaffold the next ADR from the template: `pnpm adr "short title"`. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ADR_DIR = join(import.meta.dirname, '..', 'docs', 'adr');

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function main(): Promise<void> {
  const title = process.argv.slice(2).join(' ').trim();
  if (title === '') {
    console.error('Usage: pnpm adr "short title"');
    process.exit(64);
  }

  const entries = await readdir(ADR_DIR);
  const numbers = entries
    .map((name) => /^(\d{4})-/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  const next = String(Math.max(0, ...numbers) + 1).padStart(4, '0');

  const path = join(ADR_DIR, `${next}-${slugify(title)}.md`);
  const template = await readFile(join(ADR_DIR, 'template.md'), 'utf8');
  const content = template
    .replace('# ADR-NNNN: <title>', `# ADR-${next}: ${title}`)
    .replace('- **Date:** YYYY-MM-DD', `- **Date:** ${new Date().toISOString().slice(0, 10)}`);

  await writeFile(path, content, { flag: 'wx' });
  console.log(`Created ${path}`);
  console.log('Remember to add it to docs/adr/README.md.');
}

await main();
