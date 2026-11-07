# Quality gate

Runs the project's own checks when a turn ends and sends the failure evidence back to the model, so a turn does not close while its checks are unresolved.

## What the card changes

- **The "Gate" section** — `enabled` (on by default); with it off nothing runs at all and the model may close a turn whose code is broken. `maxInjectsPerTurn` (1–5, default 2) caps how many repair instructions one session receives across turns; that is what keeps a repair loop from running away. `gateBudgetMs` (10000–600000, default 300000, shown in seconds) is the total time all checks in one turn may use: going past it is reported as "could not run", never treated as a pass.
- **Memory feedback** — `memoryFeedback` (off by default); only when it is on does the failure evidence go to the memory gateway's L0 layer. Reporting to the lesson bus is not affected by this switch. `memoryGatewayUrl` has no shipped default: when it is empty the plugin uses the `TDAI_GATEWAY_URL` environment variable instead, and if both are empty the feature is simply unconfigured. `memoryGatewayKeyRef` (default `TDAI_GATEWAY_KEY`) stores only the credential **name**; the secret stays in the host's credential service and never enters settings. Clearing the field restores the default name rather than turning feedback off.

These are read again each turn, so a change applies on the next turn without restarting the host. For feedback to actually reach the gateway, the switch must be on, the URL must resolve to a value, and the credential service must hold a value under the referenced name.

## Values that need a restart

`maxRootDepth` (default 10, how many levels up from an edited file the plugin looks for a project root) and `gateStdoutMaxBytes` (65536) are deployment defaults kept off the card on purpose. Set them in the `config:` block of this plugin's row in `cordis.patch.yml`; they take effect on restart.

Also worth knowing: after a host restart the turn cursor goes back to the fork point, so the first turn after a restart re-runs the checks.

## What it needs from outside

The check commands are decided per project root and never invented: `pnpm check` only when that root's `package.json` declares a `check` script, otherwise `cargo check`, then `ruff check .` only with a `ruff.toml` or a `[tool.ruff]` section, and otherwise `tsc --noEmit`. They run through the host sandbox, so `SANDBOX_UNAVAILABLE` means the command never ran, not that it passed. To talk to a memory gateway you also need a reachable URL and a credential stored under the referenced name.

## More detail

The order the checks are tried in, why picking the wrong one looks like a failure that is not real, how edited files are recorded, and how output that exceeds the limit is written to disk are all in the packaged README (`README.md` / `README.zh-CN.md`).
