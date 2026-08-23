# Security policy

## Supported versions

The current `0.2.x` line is tested against DeepSeek Harness `0.1.1-rc.2`, Pi coding agent `0.84.2`, and Node.js `>=22.19.0`. DeepSeek Harness is a developer preview; other combinations are unsupported until this repository's full verification suite is rerun.

## Runtime boundary

The host captures a bounded Git snapshot and starts the Pi Worker under the Harness `read-only` sandbox. The default policy refuses to run unless the provider reports `full` enforcement. The Worker exposes only scoped read/search tools plus immutable diff retrieval and terminal structured submission.

Setting `requireFullSandbox: false` is an unsafe deployment opt-out: it permits partial enforcement and must not be treated as equivalent isolation. Version 0.2 supports only standalone repositories with a physical `.git/` directory. Gitfiles/linked worktrees, `commondir`, object alternates, command-capable Git filters, and live tracked/untracked current paths that are symlinks, hardlinks, submodules, or special files fail closed. Ordinary local `.git/` metadata is trusted host input; repository worktree data is not. Staged, branch, and commit reviews expose only their frozen diff, never live same-path worktree contents. Branch review requires one unique merge base; commit review accepts only an ordinary commit with exactly one parent.

This boundary prevents repository writes; it is not a confidentiality sandbox:

- the selected diff and changed-file content are sent to the configured model provider;
- `modelProfiles` is a deployment-owned data-destination allowlist; each entry explicitly authorizes the selected code to be sent to that exact Provider/model, while per-call selection still requires a direct-human turn;
- the Worker reads Pi credentials and model configuration from its configured agent directory;
- Pi configuration values using `!command` are not executed; command-valued auth providers are unavailable and command-valued model resolver fields fail closed;
- custom `models.json` is unsupported by the read-only Worker on Windows in version 0.2;
- model API traffic is expected and allowed;
- provider retention, training, jurisdiction, and access controls remain the deployer's responsibility;
- prompt-injection defenses reduce risk but cannot make model output trustworthy without human verification.

The plugin intentionally does not expose arbitrary full-file review. Existing `paths` only narrows a captured Git change set; it cannot be used to send unrelated repository files to the Provider. Reported token totals come from Pi's isolated in-memory Session, and `estimatedCostUsd` is a model-catalog estimate rather than billing evidence.

Git installs may execute this package's `prepare` build outside the Agent sandbox after the user explicitly allowlists it in pnpm. Pin an audited commit or install a locally built tarball.

## Reporting a vulnerability

For a non-sensitive defect, open a GitHub issue with the affected version and a minimal reproduction. Do not put credentials, proprietary source, or exploitable private details in a public issue. For sensitive reports, contact the maintainer privately through GitHub before sharing details, or use the repository's private vulnerability-reporting channel when available.

Please include:

- DeepSeek Harness, Pi, Node.js, OS, and plugin versions;
- the configured sandbox enforcement and review scope;
- whether the issue occurs before model invocation, inside the Worker, or while validating its response;
- a sanitized reproduction that contains no real secrets or private code.
