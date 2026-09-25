import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, silentLogger, ulid } from '@interlock/shared';
import type {
  BranchRefId,
  ChangeSet,
  ChangeSetId,
  Evidence,
  Finding,
  LogRecord,
  MergeConflictEvidence,
  RepoId,
  SpanEvidence,
  SpeculativeRunId,
} from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { textualAnalyzer } from '../src/analyzers/textual.js';
import type { AnalyzerContext, AnalyzerOutcome } from '../src/analyzers/analyzer.js';
import { createGitRunner } from '../src/git/repo-handle.js';
import type { GitRunner, UserRepo } from '../src/git/repo-handle.js';
import { ensureShadow } from '../src/git/shadow.js';
import {
  MAX_EXCERPT_LINES,
  MAX_FINDINGS_PER_RUN,
  classifyTextualConflicts,
  textualFindingKey,
} from '../src/merge/conflict-classifier.js';
import { speculativeMerge } from '../src/merge/speculative-merge.js';
import type { SpeculativeMergeRequest } from '../src/merge/speculative-merge.js';
import { TEXTUAL_FIXTURES } from './support/textual-fixtures.js';
import type { BranchChange } from './support/textual-fixtures.js';

/**
 * Textual classification, end to end: real repositories, a real shadow, the
 * real merge, and the analyzer as the pipeline will call it.
 *
 * Spans are asserted against each branch's own file as git holds it, never
 * against the merged file — the whole point of a span is that an agent can open
 * its own copy at those lines.
 */
describe('textual conflicts', () => {
  let base: string;
  let dir: string;
  let dataDir: string;
  const runner = createGitRunner();
  const branchA = ulid<BranchRefId>();
  const branchB = ulid<BranchRefId>();

  const gitIn = (where: string, ...args: string[]): string =>
    execFileSync('git', ['-C', where, ...args], { stdio: 'pipe', encoding: 'utf8' });
  const git = (...args: string[]): string => gitIn(dir, ...args);
  const head = (): string => git('rev-parse', 'HEAD').trim();

  const write = (path: string, content: string | Buffer): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  const apply = (change: BranchChange): void => {
    for (const [from, to] of change.rename ?? []) git('mv', from, to);
    for (const [path, content] of Object.entries(change.write ?? {})) write(path, content);
    for (const path of change.remove ?? []) git('rm', '-q', path);
  };

  const commit = (message: string): string => {
    git('add', '-A');
    git('commit', '-qm', message);
    return head();
  };

  /** A base commit, two branches off it, and a shadow that can see all three. */
  const pair = async (
    setup: () => void,
    one: () => void,
    two: () => void,
  ): Promise<SpeculativeMergeRequest> => {
    setup();
    const mergeBaseSha = commit('base');
    git('checkout', '-qb', 'one');
    one();
    const commitA = commit('one');
    git('checkout', '-q', mergeBaseSha);
    git('checkout', '-qb', 'two');
    two();
    const commitB = commit('two');
    git('checkout', '-q', 'main');
    const repo: UserRepo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
    const shadow = await ensureShadow(repo, {
      runner,
      dataDir,
      repoId: '01JBQ0000000000000000TEXT' as RepoId,
    });
    return { shadow, commitA, commitB, mergeBaseSha };
  };

  const changeSet = (branchRefId: BranchRefId, request: SpeculativeMergeRequest): ChangeSet => ({
    id: ulid<ChangeSetId>(),
    branchRefId,
    snapshotId: null,
    mergeBaseSha: request.mergeBaseSha,
    headSha: branchRefId === branchA ? request.commitA : request.commitB,
    files: [],
    computedAt: new Date().toISOString(),
  });

  const context = async (
    request: SpeculativeMergeRequest,
    using: GitRunner = runner,
  ): Promise<AnalyzerContext> => ({
    runId: ulid<SpeculativeRunId>(),
    branchA,
    branchB,
    changeSetA: changeSet(branchA, request),
    changeSetB: changeSet(branchB, request),
    mergeRequest: request,
    merged: await speculativeMerge(request, { runner }),
    worktree: null,
    runner: using,
    logger: silentLogger,
    signal: new AbortController().signal,
  });

  const analyze = async (request: SpeculativeMergeRequest): Promise<AnalyzerOutcome> =>
    textualAnalyzer.analyze(await context(request));

  const provenanceOf = (finding: Finding): MergeConflictEvidence => {
    const found = finding.evidence.filter(
      (e): e is MergeConflictEvidence => e.type === 'merge-conflict',
    );
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  const spansOf = (finding: Finding, branch: BranchRefId): SpanEvidence[] =>
    finding.evidence.filter(
      (e: Evidence): e is SpanEvidence => e.type === 'span' && e.branchRefId === branch,
    );

  /** The lines a span names, read from that branch's own commit. */
  const linesAt = (commit: string, span: SpanEvidence): string[] =>
    gitIn(dir, 'cat-file', 'blob', `${commit}:${span.path}`)
      .split('\n')
      .slice(span.startLine - 1, span.endLine);

  beforeEach(() => {
    // git answers with fully-resolved paths, and on macOS /var is a symlink to
    // /private/var, so the fixture works in canonical form throughout.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-textual-')));
    dir = join(base, 'user');
    dataDir = join(base, 'data');
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    git('config', 'user.name', 'Interlock Test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'maintenance.auto', 'false');
    git('config', 'gc.auto', '0');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe.each(TEXTUAL_FIXTURES)('$name', (fixture) => {
    const build = (): Promise<SpeculativeMergeRequest> =>
      pair(
        () => {
          for (const [path, content] of Object.entries(fixture.base)) write(path, content);
        },
        () => apply(fixture.one),
        () => apply(fixture.two),
      );

    if (fixture.expected === null) {
      it('merges cleanly and raises nothing', async () => {
        const request = await build();
        const ctx = await context(request);

        expect(ctx.merged.clean).toBe(true);
        expect(textualAnalyzer.appliesTo(ctx)).toBe(false);
        expect(await textualAnalyzer.analyze(ctx)).toEqual({ verdict: 'clean', findings: [] });
      });
      return;
    }

    const expected = fixture.expected;
    it(`is caught by the ${expected.analyzer} analyzer as ${expected.class}`, async () => {
      const request = await build();
      const ctx = await context(request);
      expect(textualAnalyzer.appliesTo(ctx)).toBe(true);

      const outcome = await textualAnalyzer.analyze(ctx);

      expect(outcome.verdict).toBe('findings');
      expect(outcome.findings).toHaveLength(1);
      const finding = outcome.findings[0]!;
      expect(finding).toMatchObject({
        runId: ctx.runId,
        kind: expected.analyzer,
        rule: expected.class,
        confidence: 1,
        status: 'open',
        attribution: { branchA, branchB, originBranch: null },
        resolvedAt: null,
      });
      expect(finding.attribution.rationale).not.toBe('');

      const provenance = provenanceOf(finding);
      expect(provenance).toMatchObject({
        mergeBaseSha: request.mergeBaseSha,
        commitA: request.commitA,
        commitB: request.commitB,
        path: expected.path,
      });
      expect(provenance.sideA?.path ?? null).toBe(expected.pathA);
      expect(provenance.sideB?.path ?? null).toBe(expected.pathB);

      const check = (
        branch: BranchRefId,
        commit: string,
        want: readonly [number, number] | null,
        path: string | null,
      ): void => {
        const spans = spansOf(finding, branch);
        if (want === null) {
          expect(spans).toEqual([]);
          return;
        }
        expect(spans).toHaveLength(1);
        const span = spans[0]!;
        expect(span.path).toBe(path);
        expect([span.startLine, span.endLine]).toEqual(want);
        // The excerpt is the branch's own lines, and the labelled symbol is in them.
        expect(span.excerpt).toBe(linesAt(commit, span).join('\n'));
        expect(span.excerpt).toContain(expected.symbol);
      };
      check(branchA, request.commitA, expected.spanA, expected.pathA);
      check(branchB, request.commitB, expected.spanB, expected.pathB);
    });
  });

  describe('spans', () => {
    it('are placed in each branch’s own file, not the merged one', async () => {
      // Both sides shift the conflict by different amounts, in opposite
      // directions, with changes that merge cleanly: the region sits at a line
      // in the merged file that neither branch has it on.
      const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
      const request = await pair(
        () => write('f.txt', `${body.join('\n')}\n`),
        () => {
          const lines = [...body];
          lines[19] = 'ours';
          lines.splice(1, 0, 'added 1', 'added 2', 'added 3', 'added 4', 'added 5');
          write('f.txt', `${lines.join('\n')}\n`);
        },
        () => {
          const lines = [...body];
          lines[19] = 'theirs';
          lines.splice(8, 3);
          write('f.txt', `${lines.join('\n')}\n`);
        },
      );

      const [finding] = (await analyze(request)).findings;
      const [a] = spansOf(finding!, branchA);
      const [b] = spansOf(finding!, branchB);

      expect(a).toMatchObject({ startLine: 25, endLine: 25, excerpt: 'ours' });
      expect(b).toMatchObject({ startLine: 17, endLine: 17, excerpt: 'theirs' });
      const merged = await speculativeMerge(request, { runner });
      expect(merged.conflictBlocks[0]!.startLine).not.toBe(25);
      expect(merged.conflictBlocks[0]!.startLine).not.toBe(17);
    });

    it('give a side that deleted the lines an empty span where they were', async () => {
      const request = await pair(
        () => write('f.txt', 'a\nb\nc\nd\n'),
        () => write('f.txt', 'a\nd\n'),
        () => write('f.txt', 'a\nB\nc\nd\n'),
      );

      const [finding] = (await analyze(request)).findings;

      expect(finding!.rule).toBe('overlapping-edit');
      expect(spansOf(finding!, branchA)).toMatchObject([{ startLine: 2, endLine: 1, excerpt: '' }]);
      expect(spansOf(finding!, branchB)).toMatchObject([{ startLine: 2, endLine: 3 }]);
    });

    it('cover regions on the first and the last line of a file', async () => {
      const request = await pair(
        () => write('f.txt', 'first\nmiddle 1\nmiddle 2\nmiddle 3\nmiddle 4\nlast\n'),
        () => write('f.txt', 'FIRST-A\nmiddle 1\nmiddle 2\nmiddle 3\nmiddle 4\nLAST-A\n'),
        () => write('f.txt', 'FIRST-B\nmiddle 1\nmiddle 2\nmiddle 3\nmiddle 4\nLAST-B\n'),
      );

      const [finding] = (await analyze(request)).findings;

      expect(spansOf(finding!, branchA)).toMatchObject([
        { startLine: 1, endLine: 1, excerpt: 'FIRST-A' },
        { startLine: 6, endLine: 6, excerpt: 'LAST-A' },
      ]);
      expect(spansOf(finding!, branchB)).toMatchObject([
        { startLine: 1, endLine: 1, excerpt: 'FIRST-B' },
        { startLine: 6, endLine: 6, excerpt: 'LAST-B' },
      ]);
    });

    it('handle a last line with no newline after it', async () => {
      const request = await pair(
        () => write('f.txt', 'a\nb\nc'),
        () => write('f.txt', 'a\nb\nC-A'),
        () => write('f.txt', 'a\nb\nC-B'),
      );

      const [finding] = (await analyze(request)).findings;

      expect(spansOf(finding!, branchA)).toMatchObject([
        { startLine: 3, endLine: 3, excerpt: 'C-A' },
      ]);
      expect(spansOf(finding!, branchB)).toMatchObject([
        { startLine: 3, endLine: 3, excerpt: 'C-B' },
      ]);
    });

    it('keep CRLF lines exact, carriage returns included', async () => {
      const request = await pair(
        () => write('f.txt', 'one\r\ntwo\r\nthree\r\n'),
        () => write('f.txt', 'one\r\nTWO-A\r\nthree\r\n'),
        () => write('f.txt', 'one\r\nTWO-B\r\nthree\r\n'),
      );

      const [finding] = (await analyze(request)).findings;

      expect(finding!.rule).toBe('overlapping-edit');
      expect(spansOf(finding!, branchA)).toMatchObject([
        { startLine: 2, endLine: 2, excerpt: 'TWO-A\r' },
      ]);
      expect(spansOf(finding!, branchB)).toMatchObject([
        { startLine: 2, endLine: 2, excerpt: 'TWO-B\r' },
      ]);
    });

    it('name a path holding a newline as it is', async () => {
      const path = 'odd\nname.txt';
      const request = await pair(
        () => write(path, 'x\n'),
        () => write(path, 'A\n'),
        () => write(path, 'B\n'),
      );

      const [finding] = (await analyze(request)).findings;

      expect(provenanceOf(finding!).path).toBe(path);
      expect(spansOf(finding!, branchA)).toMatchObject([{ path, startLine: 1, endLine: 1 }]);
      expect(spansOf(finding!, branchB)).toMatchObject([{ path, startLine: 1, endLine: 1 }]);
      // Repository content stays in evidence, where the agent boundary wraps it.
      expect(finding!.title).not.toContain('name.txt');
      expect(finding!.description).not.toContain('name.txt');
    });

    it('are bounded excerpts, never the whole region', async () => {
      const many = (tag: string): string =>
        Array.from({ length: 40 }, (_, i) => `${tag} ${i}`).join('\n');
      const request = await pair(
        () => write('f.txt', 'start\nx\nend\n'),
        () => write('f.txt', `start\n${many('a')}\nend\n`),
        () => write('f.txt', `start\n${many('b')}\nend\n`),
      );

      const [finding] = (await analyze(request)).findings;
      const [a] = spansOf(finding!, branchA);

      expect(a).toMatchObject({ startLine: 2, endLine: 41 });
      expect(a!.excerpt.split('\n')).toHaveLength(MAX_EXCERPT_LINES);
    });
  });

  describe('a binary conflict', () => {
    it('is an overlapping edit with no span, since there are no lines to place', async () => {
      const request = await pair(
        () => write('img.bin', Buffer.from([0, 1, 2, 3])),
        () => write('img.bin', Buffer.from([0, 1, 2, 4])),
        () => write('img.bin', Buffer.from([0, 1, 2, 5])),
      );

      const [finding] = (await analyze(request)).findings;

      expect(finding!.rule).toBe('overlapping-edit');
      expect(finding!.evidence.filter((e) => e.type === 'span')).toEqual([]);
      expect(provenanceOf(finding!).conflictTypes).toEqual(
        expect.arrayContaining(['CONFLICT (binary)', 'CONFLICT (contents)']),
      );
    });

    it('added on both sides is an add/add with no span', async () => {
      const request = await pair(
        () => write('README', 'r\n'),
        () => write('img.bin', Buffer.from([0, 1, 2, 4])),
        () => write('img.bin', Buffer.from([0, 1, 2, 5])),
      );

      const [finding] = (await analyze(request)).findings;

      expect(finding!.rule).toBe('add-add');
      expect(finding!.evidence.filter((e) => e.type === 'span')).toEqual([]);
    });
  });

  describe('many conflicted files', () => {
    it(`raise at most ${MAX_FINDINGS_PER_RUN} Findings, the most severe first`, async () => {
      const files = Array.from({ length: 60 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
      const request = await pair(
        () => {
          for (const file of files) write(file, 'a\nb\nc\n');
          write('zz-gone.txt', 'a\nb\nc\n');
        },
        () => {
          // Adjacent on every file, so each is low; the modify/delete is high.
          for (const file of files) write(file, 'A\nb\nc\n');
          write('zz-gone.txt', 'a\nB\nc\n');
        },
        () => {
          for (const file of files) write(file, 'a\nB\nc\n');
          git('rm', '-q', 'zz-gone.txt');
        },
      );

      const records: LogRecord[] = [];
      const logger = createLogger('test', { level: 'debug', sink: (r) => records.push(r) });
      const outcome = await textualAnalyzer.analyze({ ...(await context(request)), logger });

      expect(outcome.findings).toHaveLength(MAX_FINDINGS_PER_RUN);
      expect(outcome.findings[0]!.rule).toBe('delete-vs-modify');
      expect(outcome.findings.slice(1).every((f) => f.rule === 'adjacent-addition')).toBe(true);
      expect(records).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          dropped: 61 - MAX_FINDINGS_PER_RUN,
          bound: MAX_FINDINGS_PER_RUN,
        }),
      );
    });

    it('report how many paths went unexamined', async () => {
      const request = await pair(
        () => write('README', 'r\n'),
        () => write('f.txt', 'a\n'),
        () => write('f.txt', 'b\n'),
      );

      const classified = await classifyTextualConflicts(
        {
          runId: ulid<SpeculativeRunId>(),
          branchA,
          branchB,
          merge: request,
          merged: await speculativeMerge(request, { runner }),
          now: '2026-01-01T00:00:00.000Z',
        },
        { runner },
      );

      expect(classified.dropped).toBe(0);
      expect(classified.unclassified).toEqual([]);
      expect(classified.findings[0]).toMatchObject({
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    });
  });

  describe('conflicts no class covers', () => {
    it('raise nothing, and are logged by their type', async () => {
      const request = await pair(
        () => write('x.txt', 'one\ntwo\nthree\nfour\n'),
        () => git('mv', 'x.txt', 'y.txt'),
        () => git('mv', 'x.txt', 'z.txt'),
      );
      const records: LogRecord[] = [];
      const logger = createLogger('test', { level: 'debug', sink: (r) => records.push(r) });
      const ctx = { ...(await context(request)), logger };
      expect(ctx.merged.messages.map((m) => m.type)).toContain('CONFLICT (rename/rename)');

      const outcome = await textualAnalyzer.analyze(ctx);

      expect(outcome).toEqual({ verdict: 'clean', findings: [] });
      expect(records).toContainEqual(
        expect.objectContaining({ types: ['CONFLICT (rename/rename)'] }),
      );
    });
  });

  describe('a symlink changed two ways', () => {
    it('is an overlapping edit with no span, since a target is not lines', async () => {
      const request = await pair(
        () => symlinkSync('target-0', join(dir, 'link')),
        () => {
          unlinkSync(join(dir, 'link'));
          symlinkSync('target-a', join(dir, 'link'));
        },
        () => {
          unlinkSync(join(dir, 'link'));
          symlinkSync('target-b', join(dir, 'link'));
        },
      );

      const [finding] = (await analyze(request)).findings;

      expect(finding!.rule).toBe('overlapping-edit');
      expect(provenanceOf(finding!).sideA).toMatchObject({ path: 'link', mode: '120000' });
      expect(finding!.evidence.filter((e) => e.type === 'span')).toEqual([]);
    });
  });

  describe('a side whose blob is at more than one path', () => {
    it('gets no path and no span rather than a guess', async () => {
      // B writes the same content to two files, so its half of the renamed
      // conflict could be either.
      const body = 'fn one\nfn two\nfn three\nfn four\nfn five\nfn six\n';
      const request = await pair(
        () => {
          write('parser.ts', body);
          write('copy.ts', body);
        },
        () => {
          git('mv', 'parser.ts', 'parse.ts');
          write('parse.ts', body.replace('fn two', 'fn TWO-A'));
        },
        () => {
          write('parser.ts', body.replace('fn two', 'fn TWO-B'));
          write('copy.ts', body.replace('fn two', 'fn TWO-B'));
        },
      );

      const [finding] = (await analyze(request)).findings;
      const provenance = provenanceOf(finding!);

      expect(provenance.path).toBe('parse.ts');
      expect(provenance.sideA?.path).toBe('parse.ts');
      expect(provenance.sideB?.path).toBeNull();
      expect(spansOf(finding!, branchA)).toMatchObject([{ path: 'parse.ts', startLine: 2 }]);
      expect(spansOf(finding!, branchB)).toEqual([]);
    });
  });

  describe('identity', () => {
    const run = async (
      request: SpeculativeMergeRequest,
      a: BranchRefId,
      b: BranchRefId,
    ): Promise<Finding> => {
      const outcome = await textualAnalyzer.analyze({
        ...(await context(request)),
        branchA: a,
        branchB: b,
      });
      return outcome.findings[0]!;
    };

    it('is the same for the same conflict seen again, merged either way round', async () => {
      const first = await pair(
        () => write('f.txt', 'a\nb\nc\nd\ne\nf\n'),
        () => write('f.txt', 'a\nb\nc\nd\ne\nF-A\n'),
        () => write('f.txt', 'a\nb\nc\nd\ne\nF-B\n'),
      );
      const seen = await run(first, branchA, branchB);

      // Branch A moves on above the conflict: the span moves, the finding does not.
      git('checkout', '-q', 'one');
      write('f.txt', 'new top\na\nb\nc\nd\ne\nF-A\n');
      const moved = commit('one again');
      const again = await run({ ...first, commitA: moved }, branchA, branchB);
      const swapped = await run(
        { ...first, commitA: first.commitB, commitB: moved },
        branchB,
        branchA,
      );

      expect(spansOf(again, branchA)[0]!.startLine).not.toBe(spansOf(seen, branchA)[0]!.startLine);
      expect(textualFindingKey(again)).toBe(textualFindingKey(seen));
      expect(textualFindingKey(swapped)).toBe(textualFindingKey(seen));
      expect(again.id).not.toBe(seen.id);
    });

    it('differs when the class does', async () => {
      const request = await pair(
        () => write('f.txt', 'a\nb\nc\n'),
        () => write('f.txt', 'A\nb\nc\n'),
        () => write('f.txt', 'a\nB\nc\n'),
      );
      const adjacent = await run(request, branchA, branchB);

      git('checkout', '-q', 'two');
      write('f.txt', 'A2\nB\nc\n');
      const overlapping = await run({ ...request, commitB: commit('two again') }, branchA, branchB);

      expect([adjacent.rule, overlapping.rule]).toEqual(['adjacent-addition', 'overlapping-edit']);
      expect(textualFindingKey(overlapping)).not.toBe(textualFindingKey(adjacent));
    });

    it('is null for a Finding that is not textual', () => {
      const finding = { kind: 'typecheck', evidence: [] } as unknown as Finding;
      expect(textualFindingKey(finding)).toBeNull();
    });
  });

  describe('when the shadow cannot be read', () => {
    it('is an infra-failure with a diagnostic naming no path, never an empty list', async () => {
      const request = await pair(
        () => write('secret-name.txt', 'a\n'),
        () => write('secret-name.txt', 'A\n'),
        () => write('secret-name.txt', 'B\n'),
      );
      const failing: GitRunner = {
        run: (target, args, options) =>
          args[0] === 'cat-file'
            ? Promise.resolve({ stdout: '', stderr: 'fatal: secret-name.txt', exitCode: 128 })
            : runner.run(target, args, options),
      };

      const outcome = await textualAnalyzer.analyze(await context(request, failing));

      expect(outcome.verdict).toBe('infra-failure');
      expect(outcome.findings).toEqual([]);
      expect(outcome.diagnostic).toMatch(/^GIT_COMMAND_FAILED: /u);
      expect(outcome.diagnostic).not.toContain('secret-name');
    });

    it('lets an error that is not the runner’s through, since that is a bug', async () => {
      const request = await pair(
        () => write('f.txt', 'a\n'),
        () => write('f.txt', 'A\n'),
        () => write('f.txt', 'B\n'),
      );
      const broken: GitRunner = {
        run: (target, args, options) =>
          args[0] === 'cat-file'
            ? Promise.reject(new TypeError('boom'))
            : runner.run(target, args, options),
      };

      await expect(textualAnalyzer.analyze(await context(request, broken))).rejects.toThrow('boom');
    });
  });
});
