<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-quality-gate@main/icon.svg" width="96" height="96" alt="dsh-quality-gate logo" />
</p>

<h1 align="center">dsh-quality-gate</h1>

<p align="center"><em>At turn end it runs the checks the project itself declares; a check that never ran is never recorded as passed.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-quality-gate"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-quality-gate?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-quality-gate"><img src="https://img.shields.io/npm/d18m/@jayyuen66/dsh-quality-gate?style=flat-square" alt="npm downloads (total)" /></a>
  <a href="https://github.com/JayYuen666/dsh-quality-gate/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-quality-gate/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D24.9-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.2--rc.2-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,nodejs,react,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/lang-简体中文-658EFF?style=flat-square" alt="简体中文" /></a>
</p>

**A [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin: a turn-end quality check. When the turn edited code or config files, the checks the project itself declares run before the turn closes; a failure is sent back as a repair instruction that opens a new turn, with a cap on injections per session and a cap on total running time.**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Contents

- [ Contents](#-contents)
- [ What it does](#-what-it-does)
- [ Install](#-install)
  - [ Shared version floor](#-shared-version-floor)
- [ Verify it is working](#-verify-it-is-working)
- [ What it does not provide](#-what-it-does-not-provide)
- [ Enabling it in dsh](#-enabling-it-in-dsh)
- [ The four check commands](#-the-four-check-commands)
- [ Settings](#-settings)
- [ Public interface](#-public-interface)
- [ Data and privacy](#-data-and-privacy)
- [ Known boundaries](#-known-boundaries)
- [ FAQ](#-faq)
- [ Development](#-development)
- [ License](#-license)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does

- **At turn end, not while the turn runs.** The hook is the host event `agent/turn-stopping`: read this session's **successful** edits (an idle named subagent's ledger is merged into this turn by cursor; while a teammate is still running the turn is deferred) → walk each file up to the nearest directory that has a manifest → decide which check applies → run it. A failure is sent back through `agent.followup`; the host still checks the inbox after turn-stopping, so a repair instruction opens a new turn. Under `workspace-write`, a gate root above the session cwd is granted write access for exactly this batch and released when it ends.
- **One run has exactly three outcomes**: `pass` (it really finished with exit 0), `code-failure` (it ran and reported code errors), `not-run` (it never ran). A check that did not truly finish is never recorded as passed, and "could not run" is never mixed up with "code error" — the first sends "please confirm manually", writes no memory and never reaches the lesson bus as `gate-failure`.
- **Only commands the project itself declares.** One of four whitelisted commands per root; with no declaration no command is issued — no check is better than an invented command that fails every time (see "The four check commands").
- **Keeps a repair loop from running away.** Repair injections are counted per session across turns; once the count is used up, one user-visible release note is sent and auto-repair stops. Total running time is capped; a timeout is sent as "could not run" rather than passing without a word.
- **It does not edit code, does not block dangerous commands (that is danger-guard's job) and does not write any file.**

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-quality-gate
```

Remove with `dsh plugin --profile web remove @jayyuen66/dsh-quality-gate`. The package is on the public npm registry, so installation needs no credentials.

- **Requires Node.js `>= 24.9`.** The artifacts use newer runtime features such as `AbortSignal.any`.
- **Requires a host `dsh` on the `0.2.2-rc.2` line or later.** The requirement the host reads is `engines.dsh` (`^0.2.2-rc.2`), and it **decides compatibility on its own**; pre-release versions participate in range comparison, and `0.3.0` and later need the explicit risk-accepting grant `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`. The support window rolls: this package is verified against every released host version inside the window at publish time and re-verified once the window moves, so the version numbers in this bullet are not a standing promise.
- **The runtime dependency `@jayyuen66/dsh-plugin-shared` must be on the same registry at `0.2.6` or later** (the failure-identity path reads its new `ToolResultRecord.error`); a lower copy makes the whole set 404, or that feature silently falls back to the old behavior.
- **`typescript` is a real `dependencies` entry**: the backup entry point for the `tsc` check — the project's own install wins, then the copy shipped with this package; nothing touches the network at runtime, and `npx` never downloads a compiler.
- **`zod` is also a real `dependencies` entry**: the edit-record projection state and the settings card's stored and pending values use it for shape validation, versioned through the umbrella catalog. The client artifact keeps `require("zod")` externalized through the host's `PLATFORM_MODULES`.
- **`@deepseek-ai/schemastery` is resolved from the host, not installed by this package**: only the host's fork resolves `.volatile()` fields into live references; with a public schemastery, "edit a setting" becomes "restart to apply". Two validator functions from `@deepseek-ai/dsh-credentials` are value imports, so that package sits in `peerDependencies` — keeping `@deepseek-ai/*` out of `dependencies` is a publishing rule (`test/publish-manifest.test.ts` enforces it: a host package listed there installs a second copy inside the user's profile, next to the running host).
- Installing a local directory needs pnpm ≥ 12.3.0 (12.0.0 has a known bug in that path).

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Shared version floor

If your profile pins `@jayyuen66/dsh-plugin-shared` with a pnpm `overrides` entry, that pin must be at least the version this package declares. A lower pin installs a copy without the names this package imports at runtime, and the host then reports `N entries did not activate` with `does not provide an export named ...` at startup — the package installs fine and never loads, and no single-repository CI run can see it.

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Verify it is working

1. **The layer is mounted.** `dsh --profile web --dump-config` ends with `# == @jayyuen66/dsh-quality-gate` plus `- id: quality-gate`.
   - That command is the only accepted "in the layer stack" signal, and it **is not read-only** — it rewrites the profile's root assembly file. Read the layer lines from stdout **and** check stderr separately: unmatched patch targets appear only on stderr, so the exit code alone proves nothing. Accept both forms: `# == <layer>` and `# == <layer>, patched by <path>`.
2. **The card renders.** The plugin list on the settings page shows the entry `quality-gate` (titled "Quality gate"); change a value, Save goes from disabled to enabled, and the write lands.
3. **The check really runs.** In a project it recognizes (say a TS project with `package.json` and `tsconfig.json` at the root), have the agent edit a code file and end the turn: the check command runs in that root, and on failure the model receives a repair instruction starting with `[quality-gate]`, so the turn continues instead of closing. Host log lines starting the same way carry the command and the root. If nothing changes at all, the reading is **the layer is not mounted**, not "the rules are loose".
4. **How to read "could not run".** Environment failures (sandbox denial, missing tool, out of time) send a "please confirm manually" notice, not a repair instruction — that is not evidence of a code error; do not change code because of it.

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does not provide

- **No model tools.** The whole implementation is the `agent/turn-stopping` listener; there is no `gate_status` tool to call.
- **No HTTP routes and no Remote namespace.** The settings card uses the official `configForms` form and writes through the host's channel — unlike plugins that ship their own data endpoints, the only data this package holds is its settings.
- **No CLI subcommand.**
- **No file writes, no telemetry**; the only outbound request is the memory gateway you explicitly enable (see "Data and privacy").
- Things it uses when available: the `lessonLoop` bus (lesson reports), `credentials` (key resolution), `sandboxPolicy` (per-session policy), `sessionQuery` (event reads), `shell` (running commands). All are optional `ctx.get` reads — if one is missing, only that capability is gone; the plugin still loads.

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Enabling it in dsh

- Bundle form: `dsh.bundle.patch` in `package.json` points at `cordis.patch.yml`, which carries a single `- id: quality-gate` entry with `name` set to the bare package name (the host scans `dsh.client` only on bare-name entries); `dsh plugin --profile web add/remove` maintains that line. The card components are bundled into `client.js` (only `react` / `zod` stay external to the host's module table), so the card does not depend on a second package being loaded.
- The host side needs only `settings` (`default.inject = ["settings"]`); precedence is the card's runtime value > the line's `config:` > the schema's built-in defaults.
- The client side (`dsh.client.platform = web`, `immediately: true`) injects a card into the `plugins.bundle.config` slot of the plugin page. Two identifiers, deliberately from different places: the slot key is the **bundle package name** `@jayyuen66/dsh-quality-gate`, while the settings namespace and `configForms.get()` use the **bare entry id** `quality-gate` — mix them up and the card never renders.
- Saving on the card happens in two explicit steps: edits stay in local pending state until Save writes them **one after another**, key by key, and looks at the `Promise<boolean>` that says whether the host accepted the write — the first `false` stops the loop, shows `saveRejected` and keeps the changes that were not written; a write that rejects shows `saveFailed`. Inputs stay editable while a save is running, and edits made during it stay pending instead of being cleared by that save; Revert discards the pending edits. Clearing an input means unset, which restores that field's schema default.
- Two deployment values have no row on the card and go only on the registration line's `config:`, taking effect after a restart: `maxRootDepth` (how far up to search for a project root) and `gateStdoutMaxBytes` (how much output to capture); defaults are in the settings table.

## <img src="https://api.iconify.design/lucide/terminal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> The four check commands

The whitelist is fixed at type level (the `GateCommand` union in `lib/gate-detect.ts`): only these four can reach the point where a command is run; at most one per project root, priority workspace > Rust > Python > TypeScript only.

| Command | When it is used |
| --- | --- |
| `pnpm check` | The root has both `pnpm-workspace.yaml` and `package.json`, and the root scripts declare a non-empty `check`. A workspace root without `check` gets no command at all — it does not fall back to `tsc` (see below) |
| `cargo check` | The root has a `Cargo.toml` |
| `ruff check .` | The root has a `ruff.toml`, or a `pyproject.toml` with a `[tool.ruff]` section. A bare `pyproject.toml` does not count — it is Python metadata, not a statement that the project uses ruff |
| `tsc --noEmit` | A **non-workspace** root with both `package.json` and `tsconfig.json`; without `tsconfig.json` it is not treated as a TS project. A workspace root does not qualify: its tsconfig is usually solution-style (`files: []` plus `references`), and `tsc --noEmit` then checks no subproject and exits 0 |

- `tsc` in the command is only a logical name: the entry point is decided at runtime — the project's own `typescript` first, then the copy shipped with this package, finally `tsc` on PATH (reported as not-run by the "tool unavailable" path); `npx` never downloads it.
- Root detection: from each edited file, up to `maxRootDepth` (default 10) levels to the nearest directory with a manifest; a package that is **itself** a workspace root producing `pnpm check` keeps its own root (a change in one package must not fan out into the whole multi-repository workspace), and otherwise a monorepo package is moved up to the workspace root holding `pnpm-workspace.yaml` — but only when that root **does produce a check**; otherwise the package keeps its own root (an outer workspace without a `check` script must not swallow the package's own `tsc` or `ruff` check).
- Time and concurrency: total allowance `gateBudgetMs`; each root gets the smaller of `max(10s, budget / root count)` and the time actually left; a tail with under 5s left does not start and is reported as "did not run". Checks run one after another and only one failure is sent at a time.
- Evidence caps: 64 KiB per stream stays in memory (the tail is kept, while the first error is usually the reason), and when truncated, a bounded 4 KiB excerpt from the start is read back from the spilled file; the per-session edit accumulator holds 500 files, dropping the oldest first with a warning.

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Settings

The namespace `quality-gate` is the settings entry id; the fields shown in the form are exactly the `.volatile()` ones.

| Field | Type | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch; off means nothing is checked at turn end |
| `maxInjectsPerTurn` | natural, 1–5 | `2` | How many repair instructions may be sent, counted per session across turns |
| `gateBudgetMs` | natural, 10000–600000 | `300000` | Total time allowed for all checks; a timeout is reported as "could not run" instead of passing without a word |
| `memoryFeedback` | boolean | `false` | Also store code-level failures in the memory gateway |
| `memoryGatewayUrl` | string | `""` (unset) | Gateway base URL; the setting wins, and when empty the environment variable `TDAI_GATEWAY_URL` is used |
| `memoryGatewayKeyRef` | string (credential ref name) | `TDAI_GATEWAY_KEY` | Name of the credential holding the gateway key; the value stays in the host credential service, never in settings |
| `maxRootDepth` | natural | `10` | How many levels up to search for a project root (deployment value, no row on the card) |
| `gateStdoutMaxBytes` | natural | `65536` | Output capture cap per stream (deployment value, no row on the card) |

Settings persist in the host's settings file under the dsh data directory; the card's save behaviour is described in "Enabling it in dsh".

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Public interface

- **No HTTP endpoints**: this package registers no routes and offers no interface for outside callers.
- **To the host**: the settings namespace `quality-gate` is registered implicitly (namespace = entry id; the editable fields are the `.volatile()` ones of the exported `Config`, and there is no `settings.register` call), and the schema and the registration line's `config` share that one `Config`. The page policy is declared `auto: false` — this package ships its own card, so the host must not generate a second, automatic form.
- **Injected followups** are `role: "user"` with `source: { kind: "plugin:quality-gate" }` and an id built from the prefix `quality-gate-` plus a UUID.
- **Four kinds of text reach the model**, each carrying a `[quality-gate]` prefix plus the command and the root: a repair instruction; a "could not run" notice (which includes the list of checks skipped for lack of time); a release note once the injection count is used up.
- **Logging** goes through the host's named logger (its `info`, `warn` and `error` methods), falling back to `console` only when that service is missing.
- **Language**: host-side text follows the official `locale` settings preference, defaults to Chinese when that namespace is not registered, and takes effect on the next turn; the card's own text goes through the official client locale, and switching language re-renders the slot without reloading the page.
- **To the bus** (when lesson-loop is installed): `report({ source: "quality-gate", category: "gate-failure" | "gate-not-run", cwd, sessionId, turn, signature: the command string, detail: the full evidence, evidence: { root, command, kind } })`. When the bus is missing the report is simply dropped and the checks keep working; the `memoryFeedback` switch does not affect bus reporting.
- **Optional outbound request**: a `POST /v2/conversation/add` to `memoryGatewayUrl`, with a 5s timeout. The headers carry a Bearer token and `x-tdai-service-id` (the environment variable `TDAI_SERVICE_ID` overrides it, default `default`); the body is `session_id: "dsh-agent"` plus one `assistant` message, whose `agent_id` is the cwd's last directory name with an 8-character sha256 prefix (the same function lesson-loop uses for its project keys).

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Data and privacy

| Item | Facts |
| --- | --- |
| Nothing leaves by default | `memoryFeedback` off plus an empty URL are two independent guards — with either empty, nothing is sent and the credential store is not even queried |
| What leaves the machine | When enabled, only the command, the project root and the full error text (folded onto one line, not truncated) — sent to **the gateway you configured** |
| URL and credential safety | Credentials go to `https` or loopback addresses only (`127.0.0.0/8`, IPv6 loopback, `localhost`); `localhost` depends on the local hosts file and DNS, and is a deliberate exception — if hosts points elsewhere, credentials go there. Plain `http` to a non-loopback host is refused as unconfigured, with the reason stated. A base URL that does not parse as a valid `http(s)` URL also counts as unconfigured; URLs with userinfo are rejected |
| The key | The value lives in the host credential service (a credentials file under `$DSH_HOME`); settings store only the reference name, and a name that is not a valid POSIX variable name counts as unconfigured |
| Failure handling | A failed push only warns and never blocks the turn end: missing configuration or an unsafe URL is reported once per load; HTTP non-2xx, timeouts and send errors are logged every time they happen (collapsing them would hide a persistent fault) |
| File reads | Whether manifests exist, the root `package.json` scripts, `pyproject.toml` section headers, the start of a truncated output file written to disk; no file writes, no telemetry |
| Memory | Per-session state (edit records, injection count, event cursors) lives in process memory and is cleared when the plugin unloads |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Known boundaries

- **The whitelist has exactly four commands and cannot be extended through settings.** Roots checked by other tools (`go test`, `mypy`, `eslint`, …) get no command.
- **Only successful edits count**, and only writes through `edit`, `write`, `str_replace_editor` and `apply_patch` (`view` is read-only). A multi-file `apply_patch` records every operation target, including both sides of a move. A call whose result identity is an approval rejection or a pre-dispatch cancellation is not recorded (the tool never ran, so no file changed); a call aborted after dispatch is recorded conservatively (the write may already be on disk, so checking again is the safer side). Files outside the extension whitelist (md/txt/images/`.sh`) are not counted — none of the check commands can validate them, and for a `.sh` the root would resolve somewhere else and produce a failure that is not real.
- **Named subagents in the same tree are covered**: an idle or cold subagent's edit ledger is merged into the parent turn through `sessionQuery.inspectSession`, and a failure names the subagents that touched that root. While a teammate is still running its turn the parent gate is **deferred** (the tree is being written concurrently) and runs on the next turn that teammate completion opens. Out-of-process subagents (ACP, claude-code, codex) emit no dsh events and do not share this working tree, so they remain outside the checks.
- **Never talks over the user**: nothing is injected when the inbox has pending items, the turn signal is aborted, or the plugin is unloading. Plan mode is not exempt — a planning turn that touched code is checked the same way.
- **When evidence is truncated and no file was written, the first error may already be gone**; the text says the evidence is incomplete instead of pretending otherwise.
- **When the sandbox policy cannot be resolved, no command runs at all** (reported as not-run); it never falls back to the deployment-level policy — that would run the check outside the sandbox, have it denied, and produce a repair instruction that is not about your code.

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> FAQ

| Question | Answer |
| --- | --- |
| Why did my pnpm project not run `pnpm check`? | Its root must have both `pnpm-workspace.yaml` and `package.json`, with a non-empty `check` script in the root scripts. Without `pnpm-workspace.yaml` the next candidate applies (a non-workspace root may reach `tsc`, `ruff` or `cargo`); a workspace root without `check` gets no command at all (a solution-style tsconfig would make `tsc` report success every time). This is a deliberate choice: a false failure costs more than a missed check |
| It said "could not run" — is my code broken? | No. Sandbox policy denial, a runner that will not start, a timeout, a cancellation, running out of time, and exit 126/127 **whose stderr names the check command itself** (tool not installed) all land here. The injected text explicitly says **do not change code because of it**, and it is reported separately as `gate-not-run`. A 126/127 raised *inside* your own `check` script is a code failure and is reported as one |
| Can it loop forever? | Once the injection count is used up it sends one user-visible release note, stops auto-repair, and starts counting again only after a fully clean pass |
| Stop it temporarily? | Turn off `enabled` on the card, or run `dsh plugin --profile web remove @jayyuen66/dsh-quality-gate` |
| Which `tsc` is used? | The project's own install first, then the `typescript` shipped with this package, and PATH only as the last resort — never a download through `npx` |
| What about code edited by subagents? | In-process subagents are skipped as well, and their edits are recorded in their own session rather than the parent's — there is currently no guarantee that the parent turn reviews them (they can be missed); out-of-process subagents emit no dsh events, so they are outside the checks by construction |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Development

```sh
pnpm install
pnpm run check   # typecheck (four tsconfigs) → lint → client build → host build → tests (with coverage) → tarball check → format
```

- Coverage is measured over `host.ts`, `lib/**` and `src/ui-messages.ts`, with all four thresholds at 100%. The dictionary is plain data and `test/client-card.test.ts` covers it fully without a browser, so counting it makes the threshold actually apply to it; `client-entry.ts` is excluded because most of it is rendering, which needs a DOM setup this package deliberately leaves out (`react-dom` and `jsdom` are not installed). Including it would make the thresholds fail permanently.
- `test/publish-manifest.test.ts` pins the publishing shape: entry points resolve, no `@deepseek-ai/*` under `dependencies`, no dates or local machine paths in the artifacts, with comments and documents scanned the same way. `test/dist-size.test.ts` checks the byte size of both artifacts; `check:pack` examines a real `pnpm pack` tarball.

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> License

MIT. Source at [github.com/JayYuen666/dsh-quality-gate](https://github.com/JayYuen666/dsh-quality-gate).

The mechanism is ported from ECC (MIT, © Affaan Mustafa) — running the project's own checks at turn end, and recording which files were edited. [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) records the upstream origin, what this package added on top of it, and the boundary of the runtime dependencies.
