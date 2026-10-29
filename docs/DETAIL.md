# Quality gate

Runs the project's own checks when a turn ends and hands the failure back to the model, so a turn does not close with a red gate.

## What the card changes

- **Gate** — `enabled` (on) off means the gate never runs and the model may close a broken turn. `maxInjectsPerTurn` (1–5, default 2) caps how many repair instructions one session receives across turns, which is the runaway brake. `gateBudgetMs` (10000–600000, default 300000, shown in seconds) is the whole-gate budget: exceeding it is injected as "could not run", never treated as a pass.
- **Memory feedback** — `memoryFeedback` (off by default) writes failing-gate evidence to the memory gateway's L0 layer; lesson-bus reporting is unaffected by it. `memoryGatewayUrl` (empty) has no shipped default — with it empty the plugin falls back to the `TDAI_GATEWAY_URL` environment variable, and if both are empty the feedback is simply unconfigured. `memoryGatewayKeyRef` (default `TDAI_GATEWAY_KEY`) stores only the credential **name**; the secret lives in the host's credential service and never in settings. Clearing the field restores the default name rather than turning feedback off.

These are read per turn, so a change applies on the next turn without restarting the host. Feedback reaches the gateway only when the switch is on, the URL resolves, and the credential service holds a value under the referenced name.

## Restart-only values

`maxRootDepth` (default 10, how far up a file's directory tree the plugin looks for the project root) and `gateStdoutMaxBytes` (65536) are deployment assumptions kept off the card. Set them in the `config:` block of this plugin's row in `cordis.patch.yml`; they take effect on restart.

Also worth knowing: after a host restart the turn cursor resets to the fork point, so the first turn after a restart re-runs the gates.

## What it needs from outside

The gate commands are resolved per project root and never invented: `pnpm check` only when that root's `package.json` declares a `check` script, otherwise `cargo check`, `ruff check .` only with a `ruff.toml` or a `[tool.ruff]` section, otherwise `tsc --noEmit`. They run through the host sandbox, so `SANDBOX_UNAVAILABLE` means the command never ran rather than that it passed. Talking to a memory gateway needs a reachable URL and a credential under the referenced name.

## Further detail

The detection precedence and why a wrong pick looks like a false failure, the edit ledger and spill mechanics are in the package README (`README.md` / `README.zh-CN.md`).
