# @jayyuen66/dsh-quality-gate

[中文](./README.zh-CN.md)

### What it does

- A turn-end quality gate: when the current turn edited code or config files, the checks that the project itself declares run before the turn closes; a failure opens a new turn via `agent.followup` and injects repair instructions into the model.
- One run has exactly three outcomes: `pass` (it really finished with exit 0), `code-failure` (it ran and reported code errors), `not-run` (it never ran). A check that did not truly complete is never recorded as passed.
- It does not edit code, does not block dangerous commands (that is danger-guard's job) and does not write any file.

### When it runs, and when it does not

- Trigger: the host event `agent/turn-stopping`. Flow: read the incremental event window → take this session's **successful** edits → walk each file up to the nearest manifest root → detect the gate → run it.
  - Edits counted: `edit` / `write` / `str_replace_editor` writes; `view` is read-only and does not count.
  - Manifest root: searched up from each file, max 10 levels; a monorepo package is upgraded to the workspace root holding `pnpm-workspace.yaml` only when that root yields a gate — otherwise the package keeps its own root (an outer workspace without a `check` script must not swallow the package's `tsc`/`ruff` gate).
- Skipped when:
  - `enabled: false`; the turn has no checkable edit (only md/txt/images/`.sh`, or edits that were denied or failed).
  - Subagent sessions (`origin === "subagent"` or `delegationDepth > 0`); the inbox already has pending items (the gate does not talk over the user).
  - The root yields no gate; the turn signal is aborted or the plugin is uninstalled.
- With no shell service in the host it warns once and passes through; plan mode is not exempt — a planning turn that touched code is gated the same way.

### Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-quality-gate
```

- The packages live on the public npm registry, so installs need no credentials.
- Requires a host at `@deepseek-ai/dsh` 0.2.1-rc.2 or newer (`engines.dsh`); the plugin is compiled against that host's type surface.
- The runtime dependency `@jayyuen66/dsh-plugin-shared` must already be on the same registry, otherwise the whole set 404s.
- `@deepseek-ai/schemastery` is resolved from the host, not installed by this package: the host's own fork is the only one whose `resolve` wraps `.volatile()` fields into live references, so a public `schemastery` would turn "edit a setting" into "restart to apply".
- Installing a local directory needs pnpm ≥ 12.3.0 (12.0.0 has a known bug in that path).

### Enabling it in dsh

- Loading is driven by this package's `cordis.patch.yml` (pointed at by `dsh.bundle.patch` in `package.json`), which inserts one line `- id: quality-gate` with `name` set to this package; `dsh plugin --profile web add/remove` maintains that line.
- The host half hard-depends only on `settings` (`default.inject = ["settings"]`); `shell` / `sandboxPolicy` / `lessonLoop` / `credentials` / `sessionQuery` are all optional `ctx.get` reads, so a missing one never stops the plugin from loading.
- Precedence: card runtime value > the line's `config:` > built-in default.
- The client half (`dsh.client.platform = web`, `immediately: true`) injects a card into the `plugins.bundle.config` slot of the plugin page (key = this package name, while `configForms.get()` uses the bare entry id `quality-gate`).
- Saving on the card is staged: edits stay in local pending state until Save writes them key by key into settings.
  - The write channel hands the card the `Promise<boolean>` acceptance bit verbatim: the first `false` stops the loop, shows the `saveRejected` line and keeps the unwritten changes - swallowing the acceptance bit would let the card claim "saved" while the host had refused. A rejecting write shows `saveFailed`; Revert discards the pending edits.

### The commands it runs

Four whitelist commands are locked at type level (only these can reach the execution surface); one per root, priority workspace > Rust > Python > bare TS:

- `pnpm check`: the root has both `pnpm-workspace.yaml` and `package.json`, and the root scripts declare a non-empty `check`. Without that declaration it falls back to the next candidate — better no gate than inventing a command that fails deterministically.
- `cargo check` (`Cargo.toml`), `ruff check .` (`pyproject.toml` or `ruff.toml`), `npx tsc --noEmit` (`package.json` + `tsconfig.json`; without `tsconfig.json` it is not a TS project).
- Budget and concurrency: the total budget is `gateBudgetMs`; each root gets the smaller of `max(10s, budget/root count)` and the time actually left.
  - When fewer than 5s remain the rest do not start and are injected as "did not run".
  - Gates run sequentially and only one failure is injected at a time.
- Evidence caps: 64 KiB per stream stays in memory, and when truncated a bounded 4 KiB head excerpt is read back from the spill file (the first error is the root cause); the per-session edit accumulator holds 500 files, evicting oldest-first with a warning.

### Settings

- `enabled`: boolean, default `true`. Off means no turn-end verification at all.
- `maxInjectsPerTurn`: 1–5, default `2`. Repair-injection quota, accumulated per session across turns.
- `gateBudgetMs`: 10000–600000, default `300000`. A timeout injects a failure instead of passing silently.
- `memoryFeedback`: boolean, default `false`. Whether code-level failures are additionally persisted to the memory gateway.
- `memoryGatewayUrl`: string, default empty = disabled; the setting wins, and when empty the env `TDAI_GATEWAY_URL` is the fallback.
- `memoryGatewayKeyRef`: string (a credential ref name), default `TDAI_GATEWAY_KEY`; only the ref name is stored in settings.
- Two further fields are non-volatile deployment values: the card has no row for them, they go on the registration line's `config:` only (cordis passes plain values, so a change applies on restart).
  - `maxRootDepth` defaults to `10` - that is the "max 10 levels" root search; `gateStdoutMaxBytes` defaults to `65536` - that is the "64 KiB per stream" evidence cap.

### Public surface

- No HTTP surface: this package registers no routes or endpoints and offers no interface for external calls.
- To the host: the settings namespace `quality-gate` is registered implicitly under 0.1.7 - the namespace IS the entry id, and the editable fields are the `.volatile()` ones of the `Config` the entry exports (no `settings.register` call is left).
  - The schema and the line `config` still share that one `Config`.
  - Only the page policy is declared: in the `svc.inject(["settings"], …)` child fiber it calls `settings.configure({ auto: false }, svc.fiber)` - this package ships its own card, so the host must not generate a second, automatic form.
  - Injected followups are `role: "user"` with `source: { kind: "plugin:quality-gate" }` and an id built as the prefix `quality-gate-` plus a UUID.
- Logging goes through the host's named logger (`ctx.logger("quality-gate")`, of which this package uses the `info` / `warn` / `error` face), falling back to `console` only when that service is absent.
- The text injected into the model comes in four kinds; every message carries a `[quality-gate]` prefix plus command and root context:
  - A repair instruction.
  - A "could not run" notice.
  - A release note once the quota is spent.
  - The list of gates skipped for lack of budget, embedded inside the "could not run" notice.
- Both languages ship with the package; the choice follows the official `locale` settings namespace preference and defaults to Chinese when that namespace is not registered, taking effect on the next turn.
  - The card's own text goes through the official client locale runtime: `ctx.locale.register(NS, UI_MESSAGES)` hands over the dictionary and `ctx.locale.bind(NS)` yields the getter, so a language switch re-renders the slot with no page reload.
- To the bus: `ctx.get("lessonLoop")?.report({ source: "quality-gate", category: "gate-failure" | "gate-not-run", cwd, sessionId, turn, signature: the command string, detail: the full evidence, evidence: { root, command, kind } })`.
- Optional outbound call: a `POST /v2/conversation/add` to the address in `memoryGatewayUrl`, under a hard 5s timeout.
  - Headers: a Bearer token and `x-tdai-service-id` (env overridable, default `default`).
  - Body: `session_id: "dsh-agent"` plus one `assistant` message, whose `agent_id` is the cwd's tail directory name with an 8-hex sha256 prefix (same derivation as lesson-loop's project buckets).

### Data and privacy

- Zero outbound traffic by default: `memoryFeedback` off plus an empty URL are a double lock — with either empty nothing is pushed and the credential store is not even queried.
- When enabled, the payload is only the command, the project root and the full (untruncated) error text, sent to the gateway you configured.
  - Failures only warn, at most once per load, and never block the turn.
  - The secret itself lives in the host credential service (a credentials file under `$DSH_HOME`); a ref name that is not a valid POSIX variable name counts as unconfigured.
- The relation to lesson-loop is **optional**: if the bus is absent the report is simply dropped and the gate keeps working; installing it only adds lesson persistence, and the `memoryFeedback` switch does not affect bus reporting.
  - This package only reads the disk (manifest presence, the root `package.json` scripts, the head of a spilled truncated file); it writes no file and collects no telemetry.

### FAQ

- Why did my pnpm project not run `pnpm check`? Its root `package.json` declares no non-empty `check` script — a deliberate trade: a false failure costs more than a missed check.
- The gate said "could not run" — is my code broken? No.
  - Sandbox policy denial, a runner that will not start, a timeout, a cancellation, exit 126/127, `npx` fetching a stub package and an exhausted budget all land here.
  - The injected text explicitly says "do not change code because of it", nothing is written to memory, and it is reported separately as `gate-not-run`.
- Can it loop forever? Once the quota is spent it injects one user-visible release note, stops auto-repair, and only counts again after a fully clean pass.
- To stop it temporarily: turn off `enabled` on the card, or run `dsh plugin --profile web remove @jayyuen66/dsh-quality-gate`.
- What about code edited by subagents? In-process subagents are skipped and their edits get verified by the parent session's next turn.
  - Out-of-process ones (ACP/claude-code/codex) emit no dsh events, so they are outside the gate by construction.
- Licensed MIT; the repository is in `repository.url` of `package.json`.
