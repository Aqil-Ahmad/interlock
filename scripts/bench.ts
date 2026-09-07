#!/usr/bin/env tsx
/**
 * Performance budgets.
 *
 * The daemon runs on a developer's machine all day, so these are product
 * requirements rather than curiosities: a tool that costs 12% CPU at idle gets
 * uninstalled regardless of how good its findings are.
 *
 * Results go to `eval/reports/bench-<timestamp>.json` so trends are visible
 * across weeks rather than just pass/fail today.
 */

interface Budget {
  readonly id: string;
  readonly description: string;
  readonly budget: string;
}

const BUDGETS: readonly Budget[] = [
  {
    id: 'idle-cpu',
    description: 'Steady-state CPU with 3 watched worktrees, no edits',
    budget: '<2%',
  },
  {
    id: 'schedule-latency',
    description: 'Scheduler decision latency per change event',
    budget: '<10ms',
  },
  {
    id: 'edit-to-textual-finding',
    description: 'Time from conflicting edit to textual Finding',
    budget: '<60s',
  },
  {
    id: 'edit-to-typecheck-finding',
    description: 'Time from conflicting edit to typecheck Finding',
    budget: '<3min',
  },
  {
    id: 'ast-verdict',
    description: 'AST analyzer verdict without invoking the compiler',
    budget: '<10s',
  },
  {
    id: 'shadow-disk',
    description: 'Disk used by shadow worktrees for an 8-branch repo',
    budget: 'bounded by quota',
  },
];

function main(): void {
  console.log('Interlock performance budgets\n');
  for (const budget of BUDGETS) {
    console.log(`  ${budget.id.padEnd(28)} ${budget.budget.padEnd(18)} ${budget.description}`);
  }
  console.log('\nWatcher: pnpm exec tsx scripts/watcher-bench.ts');
  console.log('The rest land with the scheduler.');
}

main();
