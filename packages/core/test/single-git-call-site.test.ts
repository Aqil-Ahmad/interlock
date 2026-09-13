import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CALL_SITES,
  findCallSites,
  isShippedSource,
  readShippedSource,
} from './support/call-sites.js';

/**
 * The git runner is the only place Interlock spawns a process.
 *
 * That is what makes the read-only promise checkable: one call site, one
 * allowlist, one place it can be broken. A prose rule decays the moment code is
 * generated across ten files at once, so this is a test rather than a sentence.
 *
 * Two halves. The scanner runs over synthetic files first, because a test that
 * only walks the real tree can show it passes today and cannot show it would
 * fail — and a check that cannot fail is not a check.
 */

const ROOT = realpathSync(join(import.meta.dirname, '..', '..', '..'));

describe('single git call site', () => {
  describe('the scanner', () => {
    const shipped = (content: string): { path: string; content: string } => ({
      path: join('packages', 'daemon', 'src', 'anywhere.ts'),
      content,
    });

    it('catches a static import under either module name', () => {
      expect(
        findCallSites([shipped("import { execFile } from 'node:child_process';")]),
      ).toHaveLength(1);
      expect(findCallSites([shipped("import { spawn } from 'child_process';")])).toHaveLength(1);
    });

    it('catches a dynamic import, which is not an import statement', () => {
      const site = findCallSites([shipped("const cp = await import('node:child_process');")]);
      expect(site).toHaveLength(1);
    });

    it('catches a require, in either spelling', () => {
      expect(findCallSites([shipped("const cp = require('child_process');")])).toHaveLength(1);
      expect(
        findCallSites([shipped("createRequire(import.meta.url)('node:child_process')")]),
      ).toHaveLength(1);
    });

    it('names the file and the line, so the failure is the diagnosis', () => {
      const [site] = findCallSites([
        shipped("import { x } from './x.js';\nimport { execFile } from 'node:child_process';"),
      ]);
      expect(site).toMatchObject({
        path: join('packages', 'daemon', 'src', 'anywhere.ts'),
        line: 2,
      });
      expect(site?.text).toContain('child_process');
    });

    it('allows the listed sites and nothing else', () => {
      const content = "import { execFile } from 'node:child_process';";
      for (const path of ALLOWED_CALL_SITES) {
        expect(findCallSites([{ path, content }]), path).toHaveLength(0);
      }
      expect(
        findCallSites([{ path: join('packages', 'core', 'src', 'git', 'other.ts'), content }]),
      ).toHaveLength(1);
    });

    it('scans every extension that ships, not only .ts', () => {
      const content = "import { execFile } from 'node:child_process';";
      for (const name of ['a.mts', 'a.cts', 'a.js', 'a.mjs', 'a.cjs']) {
        const path = join('packages', 'daemon', 'src', name);
        expect(findCallSites([{ path, content }]), name).toHaveLength(1);
      }
    });

    it('leaves tests, declarations and scripts alone', () => {
      const content = "import { execFileSync } from 'node:child_process';";
      for (const path of [
        join('packages', 'core', 'test', 'fixture.ts'),
        join('packages', 'core', 'src', 'git', 'thing.test.ts'),
        join('packages', 'core', 'src', 'git', 'thing.test.mts'),
        join('packages', 'core', 'src', 'types.d.ts'),
        join('packages', 'core', 'src', 'types.d.mts'),
        join('scripts', 'bench.ts'),
        join('eval', 'run.ts'),
        // A `src` directory outside `packages/` is still not shipped.
        join('eval', 'harness', 'src', 'run.ts'),
      ]) {
        expect(isShippedSource(path), path).toBe(false);
        expect(findCallSites([{ path, content }]), path).toHaveLength(0);
      }
    });

    it('does not match a name that merely contains the module name', () => {
      // `child_processor` is somebody's identifier, not the module.
      expect(findCallSites([shipped('const child_processor = 1;')])).toHaveLength(0);
    });
  });

  it('holds across every package today', () => {
    const files = readShippedSource(ROOT);
    // The walk found the tree it was pointed at, rather than an empty directory
    // that would pass for the wrong reason.
    for (const site of ALLOWED_CALL_SITES) {
      expect(
        files.some((file) => file.path === site),
        site,
      ).toBe(true);
    }
    expect(files.length).toBeGreaterThan(20);

    const sites = findCallSites(files);
    expect(
      sites,
      sites.map((site) => `${site.path}:${String(site.line)}  ${site.text}`).join('\n'),
    ).toStrictEqual([]);
  });
});
