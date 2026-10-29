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
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.3-658EFF?style=flat-square" alt="dsh" />
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

**A [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin: a turn-end quality gate — when the turn edited code or config files, the checks the project itself declares run before the turn closes; a failure goes back as a repair instruction that opens a new turn, under a per-session quota and a total budget.**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Verify it is live](#verify-it-is-live)
- [What it does not provide](#what-it-does-not-provide)
- [Enabling it in dsh](#enabling-it-in-dsh)
- [The four gate commands](#the-four-gate-commands)
- [Settings](#settings)
- [Public interface](#public-interface)
- [Data and privacy](#data-and-privacy)
- [Known boundaries](#known-boundaries)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does

- **Turn-end, not in-flight.** The hook is the host event `agent/turn-stopping`: read this session's **successful** edits → walk each file up to the nearest manifest root → detect the gate → run it. A failure is injected back via `agent.followup`; the host still checks the inbox after turn-stopping, so a repair instruction opens a new turn.
- **One run has exactly three outcomes**: `pass` (it really finished with exit 0), `code-failure` (it ran and reported code errors), `not-run` (it never ran). A check that did not truly complete is never recorded as passed; and "could not run" is never conflated with "code error" — the former injects "please confirm manually", writes no memory and never reaches the lesson bus as `gate-failure`.
- **Only commands the project itself declares.** One of four whitelist commands per root; without a declaration the gate is simply not issued — better no gate than an invented command that fails deterministically (see "The four gate commands").
- **Runaway protection.** Repair injections are quota'd per session across turns; once spent, one user-visible release note is injected and auto-repair stops. The total gate time is budget-capped; a timeout is injected as "could not run" instead of passing silently.
- **It does not edit code, does not block dangerous commands (that is danger-guard's job) and does not write any file.**

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-quality-gate
```

Remove with `dsh plugin --profile web remove @jayyuen66/dsh-quality-gate`. The package is on the public npm registry, so installation needs no credentials.

- **Requires Node.js `>= 22.12`.** The artifacts use newer runtime faces such as `AbortSignal.any`.
- **Requires a host `dsh` on the `0.2.1-rc.3` line.** The requirement the host reads is `engines.dsh` (`^0.2.1-rc.3`), and it **decides alone**; pre-release versions participate in range comparison, and `0.3.0` and later need the explicit, risk-accepting grant `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`.The support window rolls: this package is verified against the three most recently released host versions at publish time and re-verified once the window moves, so the version number in this bullet is not a standing promise.
- **The runtime dependency `@jayyuen66/dsh-plugin-shared` must already be on the same registry**, otherwise the whole set 404s.
- **`typescript` is a real `dependencies` entry**: the fallback entry for the `tsc` gate — the project's own install wins, then the copy shipped with this package; no network action at runtime, never an `npx` auto-download.
- **`zod` is also a real `dependencies` entry**: the edit-ledger projection state and the settings card's value/draft faces use it for shape validation, versioned through the umbrella catalog. The client artifact keeps `require("zod")` externalized via the host's `PLATFORM_MODULES`.
- **`@deepseek-ai/schemastery` is resolved from the host, not installed by this package**: only the host's fork resolves `.volatile()` fields into live references; a public schemastery turns "edit a setting" into "restart to apply". Two validator functions of `@deepseek-ai/dsh-credentials` are value imports, so that package sits in `peerDependencies` — no `@deepseek-ai/*` under `dependencies` is a publishing contract (`test/publish-manifest.test.ts` enforces it: a host package there materializes a second copy in the consumer's profile, next to the running host).
- Installing a local directory needs pnpm ≥ 12.3.0 (12.0.0 has a known bug in that path).

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Shared version floor

If your profile pins `@jayyuen66/dsh-plugin-shared` with a pnpm `overrides` entry, that pin must be at least the version this package declares. A lower pin installs a copy without the names this package imports at runtime, and the host then reports `N entries did not activate` with `does not provide an export named ...` at boot — the package installs fine and never loads, and no per-repository CI run can see it.

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Verify it is live

1. **The layer is mounted.** `dsh --profile web --dump-config` ends with `# == @jayyuen66/dsh-quality-gate` plus `- id: quality-gate`.
   - That command is the only accepted "in the layer stack" signal, and it **is not read-only** — it rewrites the profile's root assembly file. Read the layer lines from stdout **and** check stderr separately: unmatched patch targets only appear on stderr, so the exit code alone proves nothing. Accept both shapes: `# == <layer>` and `# == <layer>, patched by <path>`.
2. **The card renders.** The plugin list on the settings page shows "quality-gate turn-end quality gate"; change a value, Save goes from disabled to enabled, and the write lands.
3. **The gate really runs.** In a project it recognizes (say a TS project with `package.json` + `tsconfig.json` at the root), have the agent edit a code file and end the turn: the gate command runs in that root, and on failure the model receives a repair instruction prefixed `[quality-gate]`, so the turn continues instead of closing. Host log lines with the same prefix carry the command and root. If nothing changes at all, the reading is **the layer is not mounted**, not "the rules are loose".
4. **Reading "could not run".** Environment-class failures (sandbox denial, missing tool, exhausted budget) inject a "please confirm manually" notice, not a repair instruction — that is not evidence of a code error; do not change code because of it.

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does not provide

- **No model tools.** The whole surface is the `agent/turn-stopping` listener; there is no `gate_status` tool to call.
- **No HTTP routes and no Remote namespace.** The settings card consumes the official `configForms` form and writes through the host's channel — unlike siblings with their own data plane, this package's only data plane is settings.
- **No CLI subcommand.**
- **No file writes, no telemetry**; the only outbound request is the memory gateway you explicitly enable (see "Data and privacy").
- Optional consumption: the `lessonLoop` bus (lesson reports), `credentials` (key resolution), `sandboxPolicy` (per-session policy), `sessionQuery` (event reads), `shell` (execution). All are optional `ctx.get` reads — a missing one only removes that capability; the plugin still loads.

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Enabling it in dsh

- Bundle form: `dsh.bundle.patch` in `package.json` points at `cordis.patch.yml`, whose single registration line is `- id: quality-gate` with `name` set to the bare package name (the host scans `dsh.client` only on bare-name entries); `dsh plugin --profile web add/remove` maintains that line.
- The host half hard-depends only on `settings` (`default.inject = ["settings"]`); precedence is card runtime value > the line's `config:` > schema built-in defaults.
- The client half (`dsh.client.platform = web`, `immediately: true`) injects a card into the `plugins.bundle.config` slot of the plugin page. Two identifiers, deliberately different sources: the slot key is the **bundle package name** `@jayyuen66/dsh-quality-gate`, while the settings namespace and `configForms.get()` use the **bare entry id** `quality-gate` — mix them up and the card never renders.
- Saving on the card is explicitly staged: edits stay in local pending state until Save writes them **serially**, key by key, consuming the `Promise<boolean>` acceptance bit — the first `false` stops the loop, shows `saveRejected` and keeps the unwritten changes; a rejecting write shows `saveFailed`. Inputs stay editable during a save, and edits made in flight stay in the pending set instead of being wiped by it; Revert discards the pending edits. Clearing an input means unset, restoring that field's schema default.
- Two deployment values have no row on the card and go on the registration line's `config:` only, applying on restart: `maxRootDepth` (root search depth) and `gateStdoutMaxBytes` (evidence capture cap); defaults in the settings table.

## <img src="https://api.iconify.design/lucide/terminal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> The four gate commands

The whitelist is locked at type level (the `GateCommand` union in `lib/gate-detect.ts`): only these four can reach the execution surface; at most one per root, priority workspace > Rust > Python > bare TS.

| Command | When it is issued |
| --- | --- |
| `pnpm check` | The root has both `pnpm-workspace.yaml` and `package.json`, and the root scripts declare a non-empty `check`. Otherwise it falls back to the next candidate |
| `cargo check` | The root has a `Cargo.toml` |
| `ruff check .` | The root has a `ruff.toml`, or a `pyproject.toml` with a `[tool.ruff]` section. A bare `pyproject.toml` does not count — it is Python metadata, not a ruff opt-in |
| `tsc --noEmit` | The root has both `package.json` and `tsconfig.json`; without `tsconfig.json` it is not a TS project |

- `tsc` is only a logical name in the command: the entry is resolved at runtime — the project's own `typescript` first, then the copy shipped with this package, finally `tsc` on PATH (reported as not-run by the "tool unavailable" exit); never an `npx` auto-download.
- Root detection: from each edited file, up to `maxRootDepth` (default 10) levels to the nearest manifest root; a package that is **itself** a workspace root yielding `pnpm check` keeps its own root (a change in one package must not fan out into the whole umbrella workspace), and otherwise a monorepo package is upgraded to the workspace root holding `pnpm-workspace.yaml` — but only when that root **yields a gate**; otherwise the package keeps its own root (an outer workspace without a `check` script must not swallow the package's `tsc`/`ruff` gate).
- Budget and concurrency: total budget `gateBudgetMs`; each root gets the smaller of `max(10s, budget / root count)` and the time actually left; a tail with under 5s left does not start and is injected as "did not run". Gates run sequentially and only one failure is injected at a time.
- Evidence caps: 64 KiB per stream stays in memory (the tail is kept; the first error is the root cause), and when truncated a bounded 4 KiB head excerpt is read back from the spill file; the per-session edit accumulator holds 500 files, evicting oldest-first with a warning.

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Settings

The namespace `quality-gate` is the settings entry id; the fields projected into the form are exactly the `.volatile()` ones.

| Field | Type | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch; off means no turn-end verification at all |
| `maxInjectsPerTurn` | natural, 1–5 | `2` | Repair-injection quota, accumulated per session across turns |
| `gateBudgetMs` | natural, 10000–600000 | `300000` | Total gate budget; a timeout is injected as "could not run" instead of passing silently |
| `memoryFeedback` | boolean | `false` | Additionally persist code-level failures to the memory gateway |
| `memoryGatewayUrl` | string | `""` (unset) | Gateway base URL; the setting wins, empty falls back to the env `TDAI_GATEWAY_URL` |
| `memoryGatewayKeyRef` | string (credential ref name) | `TDAI_GATEWAY_KEY` | Ref name of the gateway key; the value lives in the host credential service, never in settings |
| `maxRootDepth` | natural | `10` | Max levels of upward root search (deployment value, no row on the card) |
| `gateStdoutMaxBytes` | natural | `65536` | Evidence capture cap per stream (deployment value, no row on the card) |

Settings persist in the host's settings file under the dsh data directory; the card's save semantics are in "Enabling it in dsh".

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Public interface

- **No HTTP surface**: this package registers no routes or endpoints and offers no interface for external calls.
- **To the host**: the settings namespace `quality-gate` is registered implicitly (namespace = entry id; editable fields are the `.volatile()` ones of the exported `Config`; there is no `settings.register` call), and the schema and the registration line's `config` share that one `Config`. The page policy is declared `auto: false` — this package ships its own card, so the host must not generate a second, automatic form.
- **Injected followups** are `role: "user"` with `source: { kind: "plugin:quality-gate" }` and an id built as the prefix `quality-gate-` plus a UUID.
- **The text injected into the model comes in four kinds**, every message carrying a `[quality-gate]` prefix plus command and root context: a repair instruction; a "could not run" notice (with the budget-starved skip list embedded); a release note once the quota is spent.
- **Logging** goes through the host's named logger (the `info` / `warn` / `error` face), falling back to `console` only when that service is absent.
- **Language**: host-side text follows the official `locale` settings preference, defaulting to Chinese when unregistered and taking effect on the next turn; the card's own text goes through the official client locale, and a language switch re-renders the slot with no page reload.
- **To the bus** (when lesson-loop is installed): `report({ source: "quality-gate", category: "gate-failure" | "gate-not-run", cwd, sessionId, turn, signature: the command string, detail: the full evidence, evidence: { root, command, kind } })`. When the bus is absent the report is simply dropped and the gate keeps working; the `memoryFeedback` switch does not affect bus reporting.
- **Optional outbound call**: a `POST /v2/conversation/add` to `memoryGatewayUrl`, under a hard 5s timeout. Headers carry a Bearer token and `x-tdai-service-id` (env `TDAI_SERVICE_ID` overrides, default `default`); the body is `session_id: "dsh-agent"` plus one `assistant` message, whose `agent_id` is the cwd's tail directory name with an 8-hex sha256 prefix (same derivation as lesson-loop's project buckets).

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Data and privacy

| Aspect | Facts |
| --- | --- |
| Zero outbound by default | `memoryFeedback` off plus an empty URL are a double lock — with either empty nothing is pushed and the credential store is not even queried |
| What leaves the machine | When enabled, only the command, the project root and the full error text (single-lined, untruncated) — sent to **your own** gateway |
| URL and credential safety | Credentials go to `https` or loopback addresses only (`localhost`, `127.0.0.0/8`, IPv6 loopback); plain `http` to a non-loopback host is refused as unconfigured, with the reason stated. A base URL that does not parse as a legal `http(s)` URL counts as unconfigured too |
| The key | The value lives in the host credential service (a credentials file under `$DSH_HOME`); settings store only the ref name, and a ref name that is not a valid POSIX variable name counts as unconfigured |
| Failure handling | Push failures only warn, at most once per load, and never block the turn |
| Disk reads | Manifest presence, the root `package.json` scripts, `pyproject.toml` section headers, the head of a spilled truncated file; no file writes, no telemetry |
| Memory | Session ledgers (edit accounting / injection quota / event cursors) live in process memory and are cleared when the plugin unloads |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Known boundaries

- **The whitelist has exactly four commands and cannot be extended via settings.** Roots checked by other tools (`go test`, `mypy`, `eslint`, …) get no gate.
- **Only successful edits count**, and only writes through `edit` / `write` / `str_replace_editor` (`view` is read-only). Files outside the extension whitelist (md/txt/images/`.sh`) are not counted — none of the gate commands can validate them, and a `.sh` would only drag the root resolution somewhere else and produce a false failure.
- **Out-of-process subagents (ACP / claude-code / codex) emit no dsh events**, so they are outside the gate by construction; in-process subagents are skipped and their edits are verified by the parent session's next turn.
- **Never talks over the user**: no injection when the inbox has pending items, the turn signal is aborted, or the plugin is unloading. Plan mode is not exempt — a planning turn that touched code is gated the same way.
- **When evidence is truncated with no spill file, the first error may already be gone**; the text says the evidence is incomplete instead of pretending otherwise.
- **When the sandbox policy cannot be resolved, no gate runs at all** (injected as not-run); it never falls back to the deployment-level policy — that would run the gate outside the sandbox, get it denied, and produce a false repair instruction.

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> FAQ

| Question | Answer |
| --- | --- |
| Why did my pnpm project not run `pnpm check`? | Its root `package.json` declares no non-empty `check` script — a deliberate trade: a false failure costs more than a missed check |
| The gate said "could not run" — is my code broken? | No. Sandbox policy denial, a runner that will not start, a timeout, a cancellation, an exhausted budget, and exit 126/127 **whose stderr names the gate command itself** (tool not installed) all land here. The injected text explicitly says **do not change code because of it**, and it is reported separately as `gate-not-run`. A 126/127 raised *inside* your own `check` script is a code failure and is reported as such |
| Can it loop forever? | Once the quota is spent it injects one user-visible release note, stops auto-repair, and only counts again after a fully clean pass |
| Stop it temporarily? | Turn off `enabled` on the card, or run `dsh plugin --profile web remove @jayyuen66/dsh-quality-gate` |
| Which `tsc` is used? | The project's own install first, then the `typescript` shipped with this package, and PATH only as the last resort — never an `npx` download |
| What about code edited by subagents? | In-process subagents are covered by the parent session's next turn; out-of-process ones emit no dsh events, so they are outside the gate by construction |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Development

```sh
pnpm install
pnpm run check   # typecheck (three tsconfigs) → lint → client build → host build → tests (with coverage) → tarball inspection → format
```

- Coverage is measured over `host.ts` and `lib/**` only, with all four thresholds at 100%. `src/` is not untested: `test/client-card.test.ts` drives the card wiring and both locale dictionaries headlessly (`ui-messages.ts` is fully executed), but most of `client-entry.ts` is the render surface, which needs a DOM harness this package deliberately omits (`react-dom`/`jsdom` are not pulled in). Counting all of `src/` would turn the thresholds into a permanent red, so they are pinned to the surface that is fully verified.
- `test/publish-manifest.test.ts` enforces the publishing shape: entry points resolve, no `@deepseek-ai/*` under `dependencies`, no dates or local paths in the artifacts, with comments and documents scanned the same way. `test/dist-size.test.ts` guards the byte budget of both artifacts; `check:pack` inspects a real `pnpm pack` tarball.

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> License

MIT. Source at [github.com/JayYuen666/dsh-quality-gate](https://github.com/JayYuen666/dsh-quality-gate).

The mechanism is ported from ECC (MIT, © Affaan Mustafa) — turn-end checks the project itself declares, and edit accounting. [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) records the upstream origin, what this package built on top of it, and the runtime-dependency boundary.
