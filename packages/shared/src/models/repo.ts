import type { RepoId } from '../ids.js';

/**
 * A watched repository.
 *
 * `rootPath` is only ever read. Writes go to `shadowPath`, the clone Interlock
 * owns under its data directory.
 */
export interface Repo {
  readonly id: RepoId;
  /** Absolute path to the repository root (the one containing `.git`). */
  readonly rootPath: string;
  /** Branch that in-flight work is expected to land on, e.g. `main`. */
  readonly defaultBranch: string;
  /** Absolute path to the shadow clone Interlock owns for this repo. */
  readonly shadowPath: string;
  /** Per-repo overrides layered on top of the global config. */
  readonly config: RepoConfigOverride;
  readonly discoveredAt: string;
  readonly lastSeenAt: string;
}

/** Subset of config a repo may override via `.interlock.json` in its root. */
export interface RepoConfigOverride {
  /** Globs excluded from watching and from ChangeSet extraction. */
  readonly ignore?: readonly string[];
  /** Branches never considered in-flight, e.g. long-lived release branches. */
  readonly ignoreBranches?: readonly string[];
  /** Explicit toolchain commands when detection gets it wrong. */
  readonly toolchain?: {
    readonly install?: string;
    readonly typecheck?: string;
    readonly build?: string;
    readonly test?: string;
  };
}
