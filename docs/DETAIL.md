# Quality gate

Runs the project's own checks when a turn ends and sends the failure evidence back to the model, so a turn does not close while its checks are unresolved.

## What the card changes

- **The "Gate" section** — `enabled` (on by default); with it off nothing runs at all and the model may close a turn whose code is broken. `maxInjectsPerTurn` (1–5, default 2) caps how many repair instructions one session receives across turns; that is what keeps a repair loop from running away. `gateBudgetMs` (10000–600000, default 300000, shown in seconds) is the total time all checks in one turn may use, handed out as a shared pool: whoever runs first draws first and only a 5s reserve is kept for each gate still queued — an even split would guarantee a timeout for a `pnpm check` that runs ten packages serially at an umbrella workspace root (measured 240s). Going past the budget is reported as "could not run", never treated as a pass.
- **Supply-chain audits** — `securityAudit` (off by default) adds one lockfile-based dependency-vulnerability scan per root when enabled (npm/pnpm/cargo/go/pip/bundler/composer), independent of a project-declared `check` and never part of root selection; it needs network access and the audit tool installed, and a missing tool is reported as not-run.
- **Memory feedback** — `memoryFeedback` (off by default); only when it is on does the failure evidence go to the memory gateway's L0 layer. Reporting to the lesson bus is not affected by this switch. `memoryGatewayUrl` has no shipped default: when it is empty the plugin uses the `TDAI_GATEWAY_URL` environment variable instead, and if both are empty the feature is simply unconfigured. `memoryGatewayKeyRef` (default `TDAI_GATEWAY_KEY`) stores only the credential **name**; the secret stays in the host's credential service and never enters settings. Clearing the field restores the default name rather than turning feedback off.

These are read again each turn, so a change applies on the next turn without restarting the host. For feedback to actually reach the gateway, the switch must be on, the URL must resolve to a value, and the credential service must hold a value under the referenced name.

## Values that need a restart

`maxRootDepth` (default 10, how many levels up from an edited file the plugin looks for a project root) and `gateStdoutMaxBytes` (65536, output capture cap) are deployment defaults kept off the card on purpose. Set them in the `config:` block of this plugin's row in `cordis.patch.yml`; they take effect on restart.

Also worth knowing: after a host restart the turn cursor goes back to the fork point, so the first turn after a restart re-runs the checks.

## What it needs from outside

The check commands are decided per project root and never invented: `pnpm check` only when that root's `package.json` declares a `check` script, otherwise `cargo check`, then `ruff check .` only with a `ruff.toml` or a `[tool.ruff]` section, and otherwise `tsc --noEmit`. A root with `MODULE.bazel` / `WORKSPACE` adds `bazel test //...`; a C/C++ root with `.clang-format` and a matching Makefile target adds that target instead of guessing a file list. Turning on `securityAudit` on the card additionally runs one lockfile-based audit per root (`npm`/`pnpm audit`, `cargo audit`, `govulncheck`, `pip-audit`, `bundler-audit` or `composer audit`); those commands need network and the audit tool installed, and a missing tool is reported as not-run rather than installed automatically. All commands run through the host sandbox, so `SANDBOX_UNAVAILABLE` means the command never ran, not that it passed. To talk to a memory gateway you also need a reachable URL and a credential stored under the referenced name.

## More detail

The order the checks are tried in, why picking the wrong one looks like a failure that is not real, how edited files are recorded, and how output that exceeds the limit is written to disk are all in the packaged README (`README.md` / `README.zh-CN.md`).

## Feedback

Issues and pull requests are welcome: [https://github.com/JayYuen666/dsh-quality-gate/issues](https://github.com/JayYuen666/dsh-quality-gate/issues).

If a plugin fails to boot, include the dsh host version, the profile install shape, and the browser console line. The `missed the module table` line is especially useful: it tells us whether the shared client row was materialized.
