# License Router

This repository is dual-licensed. The first matching rule below determines the
license for a given file or region.

| File                             | Identifier                        | Scope                                             |
| -------------------------------- | --------------------------------- | ------------------------------------------------- |
| [`LICENSE_AGPL`](./LICENSE_AGPL) | `AGPL-3.0-only`                   | Default.                                          |
| Not yet published                | `LicenseRef-Interlock-Commercial` | Files, directories, or regions marked Commercial. |

## Rules (first match wins)

1. **SPDX header** at the top of the file is authoritative — e.g. `// SPDX-License-Identifier: LicenseRef-Interlock-Commercial`.
2. **In-file regions** wrapped in REUSE snippet syntax are Commercial; everything else in the file stays AGPL:
   ```
   // SPDX-SnippetBegin
   // SPDX-SnippetCopyrightText: 2026 Aqil Ahmad
   // SPDX-License-Identifier: LicenseRef-Interlock-Commercial
   <commercial code>
   // SPDX-SnippetEnd
   ```
   Use the file's native comment style (`#` for YAML/shell, `<!-- ... -->` for Markdown/HTML, `--` for SQL).
3. **Path convention** — files named `*.ee.{ts,tsx,js,json,yaml,yml,sql,md}` or under any `ee/` directory are Commercial.
4. **Default** — AGPL-3.0-only.

Contributions are accepted under the [CLA](./CLA.md), which grants the right to
sublicense and is what makes rule 1 through 3 possible.

Reasoning: [ADR-0002](./docs/adr/0002-license.md).
