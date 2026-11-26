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
  <img src="https://img.shields.io/badge/node-%5E24.22.3%7C%7C%3E%3D26.13.1-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.3--alpha.2-658EFF?style=flat-square" alt="dsh" />
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
- [ Check commands: declarations first, then nine language ecosystems](#-check-commands-declarations-first-then-nine-language-ecosystems)
- [ Settings](#-settings)
- [ Public interface](#-public-interface)
- [ Data and privacy](#-data-and-privacy)
- [ Known boundaries](#-known-boundaries)
- [ FAQ](#-faq)
- [ Development](#-development)
- [ Feedback](#feedback)
- [ License](#-license)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does

- **At turn end, not while the turn runs.** The hook is the host event `agent/turn-stopping`: read this session's **successful** edits (an idle named subagent's ledger is merged into this turn by cursor; while a teammate is still running the turn is deferred) → walk each file up to the nearest directory that has a manifest → decide which check applies → run it. A failure is sent back through `agent.followup`; the host still checks the inbox after turn-stopping, so a repair instruction opens a new turn. Under `workspace-write`, a gate root above the session's active working directory is granted write access for exactly this batch and released when it ends.
- **One run has exactly three outcomes**: `pass` (it really finished with exit 0), `code-failure` (it ran and reported code errors), `not-run` (it never ran). A check that did not truly finish is never recorded as passed, and "could not run" is never mixed up with "code error" — the first sends "please confirm manually", writes no memory and never reaches the lesson bus as `gate-failure`.
- **Project declarations first, conservative probes second.** If the root declares its own check (a `check` script, a safe name in `pnpmScripts`, or a Makefile `check`/`test` target), that one command wins. Otherwise built-in probes may issue several commands for the same root, but only when that language's own marker exists; no marker means no command. A missed check is cheaper than an invented one that fails every time (see "Check commands: declarations first, then nine language ecosystems").
- **Keeps a repair loop from running away.** Repair injections are counted per session across turns; once the count is used up, one user-visible release note is sent and auto-repair stops. Total running time is capped; a timeout is sent as "could not run" rather than passing without a word.
- **It does not edit code, does not block dangerous commands (that is danger-guard's job) and does not write any file.**

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-quality-gate
```

Remove with `dsh plugin --profile web remove @jayyuen66/dsh-quality-gate`. The package is on the public npm registry, so installation needs no credentials.

- **Requires Node.js `^24.22.3 || >=26.13.1`.** The artifacts use newer runtime features such as `AbortSignal.any`. This is the host's own range (Node 25 sits outside it).
- **Requires a host `dsh` on the `0.2.3-alpha.2` line or later.** The requirement the host reads is `engines.dsh` (`^0.2.3-alpha.2`), and it **decides compatibility on its own**; pre-release versions participate in range comparison, and `0.3.0` and later need the explicit risk-accepting grant `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`. The support window rolls: this package is verified against every released host version inside the window at publish time and re-verified once the window moves, so the version numbers in this bullet are not a standing promise.
- **The runtime dependency `@jayyuen66/dsh-plugin-shared` must be on the same registry at `0.2.13` or later** (the single-instance lock, placeholder interpolation, card style injection and invalid-field save gate are imported from it, on top of `ToolResultRecord.error` for failure identity); a lower copy makes the whole set 404, or activation fails with `does not provide an export named ...`.
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
- **No HTTP routes.** The settings card uses the official `configForms` form and writes through the host's channel. The one Remote namespace (`qualityGate`) reads results (`latest`, `state`) and can start one manual run for an idle session (`run`); nothing in it changes settings. A session's right-click menu offers that run, and when the forge panel is installed its diff view draws the stored line diagnostics (tsc/go/cargo/ruff/rubocop/javac/dotnet/clang/PHP/eslint) as annotations.
- **No CLI subcommand.**
- **No file writes, no telemetry**; the only outbound request is the memory gateway you explicitly enable (see "Data and privacy").
- Things it uses when available: the `lessonLoop` bus (lesson reports), `credentials` (key resolution), `sandboxPolicy` (per-session policy), `sessionQuery` (event reads), `shell` (running commands). All are optional `ctx.get` reads — if one is missing, only that capability is gone; the plugin still loads.

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Enabling it in dsh

- Bundle form: `dsh.bundle.patch` in `package.json` points at `cordis.patch.yml`, which carries a `- id: dsh-plugin-shared` supplier row (keep it enabled; disabling it removes the cards' shared component supply) plus the `- id: quality-gate` entry with `name` set to the bare package name (the host scans `dsh.client` only on bare-name entries); `dsh plugin --profile web add/remove` maintains those lines. The card components come from the shared client row, externalized as `@jayyuen66/dsh-plugin-shared/client` (declared in `dsh.client.external` so the host orders the supplier row into the boot graph); the host module table provides `react`, `zod` and that shared row.
- The host side needs only `settings` (`default.inject = ["settings"]`); precedence is the card's runtime value > the line's `config:` > the schema's built-in defaults.
- The client side (`dsh.client.platform = web`, `immediately: true`) injects a card into the `plugins.bundle.config` slot of the plugin page. Two identifiers, deliberately from different places: the slot key is the **bundle package name** `@jayyuen66/dsh-quality-gate`, while the settings namespace and `configForms.get()` use the **bare entry id** `quality-gate` — mix them up and the card never renders.
- Saving on the card happens in two explicit steps: edits stay in local pending state until Save writes them **one after another**, key by key, and looks at the `Promise<boolean>` that says whether the host accepted the write — the first `false` stops the loop, shows `saveRejected` and keeps the changes that were not written; a write that rejects shows `saveFailed`. Inputs stay editable while a save is running, and edits made during it stay pending instead of being cleared by that save; Revert discards the pending edits. Clearing an input means unset, which restores that field's schema default.
- Two deployment values have no row on the card and go only on the registration line's `config:`, taking effect after a restart: `maxRootDepth` (how far up to search for a project root) and `gateStdoutMaxBytes` (how much output to capture); defaults are in the settings table.

## <img src="https://api.iconify.design/lucide/terminal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Check commands: declarations first, then nine language ecosystems

`GateCommand` is still a literal union in `lib/gate-detect.ts`: only the commands listed there can reach the execution point, and settings cannot inject an arbitrary shell string. Detection has two layers:

1. **Project declaration (wins).** A `check` script in the root `package.json` → `pnpm check`; a safe name listed in `pnpmScripts` and actually declared → `pnpm run <name>`; a `check` target in the root `Makefile` → `make check`. At most one declaration command per root, and it suppresses all built-in probes for that root. A `test` target is **not** a declaration: it is appended as the test gate, so the built-in lint/format probes still run (a Makefile that only declares `test` must not hide them).
2. **Built-in probes (fallback).** Only when the root declares nothing. The same root may produce more than one command (for example a repository with both `package.json` and `Cargo.toml`); duplicates are removed by `root + command`, and the host runs them one after another from the shared time budget.

| Language | Root marker(s) | Built-in commands | Conservative condition |
| --- | --- | --- | --- |
| JavaScript / TypeScript | `package.json` | `oxlint .` or `eslint --format unix .`; `biome check .`, `oxfmt --check .` or `prettier --check .`; `vitest run`, `jest --ci`, `tsc --noEmit` | lint/format/test only with their own config; oxlint wins over eslint, and biome/oxfmt win over prettier to avoid duplicate work; `tsc` only on a **non-workspace** root with `tsconfig.json` and no non-empty `references` |
| Rust | `Cargo.toml` | `cargo check`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --all -- --check`, `cargo test --no-run` | clippy only with `clippy.toml`/`.clippy.toml`; fmt only with `rustfmt.toml`/`.rustfmt.toml` |
| Go | `go.mod` | `go vet ./...`, `golangci-lint run`, `staticcheck ./...`, `go test ./...` | vet/test always; golangci-lint only with a `.golangci.*` config; staticcheck only with `staticcheck.conf` |
| Python | `pyproject.toml`, `ruff.toml`, `.ruff.toml`, `pytest.ini`, `tox.ini`, `setup.cfg`, `mypy.ini`, `.mypy.ini`, `pyrightconfig.json`, `.flake8`, `.pylintrc` | `ruff check .`, `ruff format --check .`, `black --check .`, `flake8`, `pyright`, `pylint .`, `pytest -q`, `mypy .` | `ruff check` only with `ruff.toml`/`.ruff.toml`/`[tool.ruff]`; `ruff format --check .` is added only when `[tool.ruff.format]`/`[format]` is explicitly declared (and not when `[tool.black]` is); black only with `[tool.black]`; flake8 only with `.flake8` or a real `[flake8]` section; pyright only with `pyrightconfig.json`/`[tool.pyright]`; pylint only with `.pylintrc`/`[tool.pylint.*]`; pytest only with `pytest.ini` or a real `[pytest]`/`[tool.pytest.ini_options]` section — a `tests/`/`test/` directory is not an entry point, because an empty suite makes `pytest -q` exit 5; mypy only with `mypy.ini`/`.mypy.ini`/`[tool.mypy]` |
| Ruby | `Gemfile`, `.rubocop.yml`, `.rspec`, `.standard.yml`, `Rakefile` | `rubocop`, `rspec`, `standardrb`, `rake check`/`rake test` | rubocop only with `.rubocop.yml`; rspec only with `.rspec`; standardrb only with `.standard.yml`/`.standard.yaml`; a declared `check` task in `Rakefile` is a project gate and wins over the built-ins; a `test` task is appended as the test gate, so rubocop/rspec/standardrb still run |
| Java / Kotlin | `pom.xml`, `build.gradle[.kts]`, `settings.gradle[.kts]`, `checkstyle.xml`, `config/checkstyle/checkstyle.xml`, `detekt.yml[.yaml]`, `config/detekt/detekt.yml[.yaml]` | `mvn -q verify` or `./mvnw -q verify` when `pom.xml` declares checkstyle/spotbugs/PMD, otherwise `mvn -q test` or `./mvnw -q test`; `gradle check`, `./gradlew check` or `gradlew.bat check`; `checkstyle -c <file> src/main/java`; `detekt --config <file>`; `ktlint` | wrapper first when present; Maven `verify` only when one of those quality plugins is really in the POM; standalone Checkstyle only without Maven/Gradle and with a `src/main/java` root; detekt only with its config; ktlint only with `.editorconfig` and a `src/main/kotlin` source root |
| C / C++ | `CMakeLists.txt`, `Makefile`, `.clang-format` | `cmake --build build`, `ctest --test-dir build --output-on-failure`; `make format-check` / `make check-format` / `make clang-format-check`; `make check` (wins over the built-ins) or `make test` (appended as the test gate) | CMake commands only when `build/CMakeCache.txt` or `build/CTestTestfile.cmake` exists; the clang-format target only when `.clang-format` and that target are both declared; Makefile targets are read from the actual target table |
| Bazel | `MODULE.bazel`, `WORKSPACE`, `WORKSPACE.bazel` | `bazel test //...` | only when one of those root files exists; this can be an expensive whole-repo build and is still bounded by `gateBudgetMs` |
| C# | `*.sln`, `*.csproj`, `*.fsproj`, `*.vbproj` | `dotnet format --verify-no-changes --nologo`, `dotnet test --nologo`, `dotnet build --nologo` | format only when a solution or single project exists and `.editorconfig` is present; test only when a project name looks like a test project; build only with a solution or exactly one project file; multiple projects without a solution get no command |
| PHP | `composer.json`, `phpunit.xml[.dist]`, `phpstan.neon[.dist]`, `psalm.xml[.dist]`, `.php-cs-fixer.php` | `composer run-script test`, `composer validate --no-check-publish`, `php-cs-fixer fix --dry-run --diff`, `phpstan analyse`, `psalm`, `phpunit` | composer test script only when declared; php-cs-fixer/phpstan/psalm only with their own config; local PHPUnit binary preferred when present |

- **Opt-in supply-chain audits (`securityAudit: true`, off by default).** This layer is independent of a project-declared `check` (that script usually covers lint and tests, not dependency-vulnerability scanning, so the audits still run when one is declared), and it never participates in root selection (a lockfile alone does not make a root "have a gate"). A root with one of these lockfiles adds one command: `package-lock.json` / `npm-shrinkwrap.json` → `npm audit --audit-level=high --omit=dev`; `pnpm-lock.yaml` → `pnpm audit --audit-level=high --prod`; `Cargo.lock` next to `Cargo.toml` → `cargo audit`; `go.mod` → `govulncheck ./...`; `requirements.txt` → `pip-audit -r requirements.txt`; `Gemfile.lock` → `bundler-audit check --update`; `composer.lock` → `composer audit`. They need network and the tool installed; a missing shell command (127) or a missing `cargo audit` / `composer audit` subcommand is reported as `not-run`, and nothing is installed automatically. The switch is on the Gate card; keep it off unless you explicitly want these network calls in the gate budget.
- **No auto-install and no guessing.** A missing tool, a dependency tree that was never installed, or an exit 126/127 that names the tool is reported as `not-run`, never as a code failure. The package never runs `npm install`, `composer install`, `go mod download`, `dotnet restore` or similar.
- **The project's own check remains authoritative.** An aggregator script (`pnpm check`, a Makefile `check`) can run type checking, lint, tests, formatting and security scanners in the project's own order; it suppresses the built-in language probes. The only extra layer it does not suppress is an explicitly enabled `securityAudit`, which is not implied by a normal `check` script.
- **`tsc` is only a logical name**: the entry point is the project's own `typescript` first, then the copy shipped with this package, then `tsc` on PATH; `npx` never downloads it.
- **Root detection:** from each edited file, up to `maxRootDepth` (default 10) levels to the nearest directory with a marker. A package that is itself a workspace root and produces its own gate keeps its root; otherwise a monorepo package is moved up to the workspace root holding `pnpm-workspace.yaml`, but only when that root **really produces a gate**; an outer workspace without a gate must not swallow the package's own check. Audits are appended only after that root is chosen; a lockfile is not a gate candidate for this decision.
- **Time and concurrency:** `gateBudgetMs` is a shared pool. Several gates on one root consume it in order; the gate about to run takes what is left minus a 5s reserve for each gate still queued, and a tail with under 5s left is reported as "did not run". Checks run one after another and only one failure is sent at a time. Prefer a project-level aggregator when a root has many built-in gates.
- **Evidence caps:** 64 KiB per stream stays in memory (the tail is kept, while the first error is usually the reason); when truncated, a bounded 4 KiB excerpt from the start is read back from the spilled file; the per-session edit accumulator holds 500 files, dropping the oldest first with a warning.
- **Diagnostics:** gate output is parsed per command (tsc, go, cargo, ruff, rubocop, javac/Maven, dotnet, clang/gcc, PHP, eslint). The parsed `path:line` pairs feed the optional forge diff annotations; an output shape that is not recognized yields no annotation and does not change the pass/fail result.
- **Coverage boundary:** the built-in matrix covers lint/style, formatting, type checking, compilation and tests for the nine ecosystems above; `securityAudit` adds dependency-vulnerability scanning for the lockfiles listed above. Coverage thresholds are still not guessed: a percentage written into this package would be wrong for almost every project. Use a project-declared `check` script or an aggregator for coverage.

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
| `pnpmScripts` | string (comma/space separated) | `""` (none) | Extra gate scripts: `pnpm run <name>` runs only when the root package.json really declares that name (e.g. `check:all`); undeclared or unsafe names are ignored |
| `securityAudit` | boolean | `false` | Opt-in supply-chain audits (npm/pnpm/cargo/go/pip/bundler/composer); needs network and the audit tool, and runs even when the root declares its own `check`; it does not affect root selection |
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

- **The built-in matrix is conservative, not a complete multi-language quality platform.** It covers nine ecosystems with the marker-based commands above and adds supply-chain audits only when `securityAudit` is explicitly on; it does not add coverage gates or toolchain-specific type checkers that the project has not declared. A root without a recognized marker gets no command; a project whose toolchain does not match the marker should declare its own `check` script, `pnpmScripts` entry or Makefile target.
- **Only successful edits count**, and only writes through `edit`, `write`, `str_replace_editor` and `apply_patch` (`view` is read-only). A multi-file `apply_patch` records every operation target, including both sides of a move. A call whose result identity is an approval rejection or a pre-dispatch cancellation is not recorded (the tool never ran, so no file changed); a call aborted after dispatch is recorded conservatively (the write may already be on disk, so checking again is the safer side). Files outside the extension whitelist (md/txt/images/`.sh`) are not counted. The whitelist covers the nine language families above plus their manifests and build files (`.go`, `.rb`, `.java`, `.kt`, `.c/.h/.cc/.cpp/.hpp`, `.cs`, `.php`, `.xml`, `.gradle`, `.sln`, `.csproj`, `.ini`, `.cfg`, `.mod`, `.sum`, and names such as `Makefile`, `CMakeLists.txt`, `Gemfile`, `Rakefile`, `gradlew`, `mvnw`, `.rspec`, `.prettierrc`, `.flake8`, `.editorconfig`, `.oxlintrc`, `.oxfmtrc`, `.pylintrc`). A `.sh` is still excluded: no stable built-in checker covers it, and its root would resolve somewhere else and produce a failure that is not real.
- **Named subagents in the same tree are covered**: an idle or cold subagent's edit ledger is merged into the parent turn through `sessionQuery.observeSession`, and a failure names the subagents that touched that root. While a teammate is still running its turn the parent gate is **deferred** (the tree is being written concurrently) and runs on the next turn that teammate completion opens. Out-of-process subagents (ACP, claude-code, codex) emit no dsh events and do not share this working tree, so they remain outside the checks.
- **Never talks over the user**: nothing is injected when the inbox has pending items, the turn signal is aborted, or the plugin is unloading. Plan mode is not exempt — a planning turn that touched code is checked the same way.
- **When evidence is truncated and no file was written, the first error may already be gone**; the text says the evidence is incomplete instead of pretending otherwise.
- **When the sandbox policy cannot be resolved, no command runs at all** (reported as not-run); it never falls back to the deployment-level policy — that would run the check outside the sandbox, have it denied, and produce a repair instruction that is not about your code.
- **Only one instance activates per scope**: the market hot-mount subtree (`mkt-*`) and the profile's bundle layer resolve the same `host.js`, so the second `apply` steps aside with one warning in the host log — gates and the edit ledger never run twice; once the registered copy unloads, the next activation claims the lock again.

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> FAQ

| Question | Answer |
| --- | --- |
| Why did my pnpm project not run `pnpm check`? | The root `package.json` must declare a non-empty `check` script. A workspace root without `check` gets no `pnpm check` (and no fallback to `tsc` when its tsconfig is solution-style); another declared gate or a built-in language probe may still apply. This is deliberate: a false failure costs more than a missed check |
| It said "could not run" — is my code broken? | No. Sandbox policy denial, a runner that will not start, a timeout, a cancellation, running out of time, any exit 126/127 whose stderr says a command is missing or not executable (including inside your own script), a pnpm root that has a lockfile but no `node_modules` (install first), and tsc environment errors `TS2688 / TS6305 / TS6306 / TS6307` all land here. The injected text explicitly says **do not change code because of it**, and it is reported separately as `gate-not-run`. A missing tool inside a script is an environment problem, not evidence that the code is wrong |
| Can it loop forever? | Once the injection count is used up it sends one user-visible release note, stops auto-repair, and starts counting again only after a fully clean pass |
| Stop it temporarily? | Turn off `enabled` on the card, or run `dsh plugin --profile web remove @jayyuen66/dsh-quality-gate` |
| Which languages are covered? | JavaScript/TypeScript, Rust, Go, Python, Ruby, Java/Kotlin, C/C++, C# and PHP, each only with its own marker. The built-in commands are a conservative baseline, not a full quality platform: project-declared scripts remain authoritative, and supply-chain audits are opt-in through `securityAudit` |
| Which `tsc` is used? | The project's own install first, then the `typescript` shipped with this package, and PATH only as the last resort — never a download through `npx` |
| What about code edited by subagents? | A subagent's own turn runs no gate (that would run the same root twice and send a user-facing injection into the subagent); once an in-process named subagent goes idle, its ledger is merged into the parent turn by cursor, and the parent defers while a teammate is still running; out-of-process subagents emit no dsh events, so they are outside the checks by construction |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Development

```sh
pnpm install
pnpm run check   # typecheck (four tsconfigs) → lint → client build → host build → tests (with coverage) → tarball check → format
```

- Coverage is measured over `host.ts`, `lib/**`, `src/ui-messages.ts` and `src/remote.ts`, with all four thresholds at 100%. The dictionary is plain data and `test/client-card.test.ts` covers it fully without a browser, so counting it makes the threshold actually apply to it; `client-entry.ts` is excluded because most of it is rendering, which needs a DOM setup this package deliberately leaves out (`react-dom` and `jsdom` are not installed). Including it would make the thresholds fail permanently.
- `test/publish-manifest.test.ts` pins the publishing shape: entry points resolve, no `@deepseek-ai/*` under `dependencies`, no dates or local machine paths in the artifacts, with comments and documents scanned the same way. `test/dist-size.test.ts` checks the byte size of both artifacts; `check:pack` examines a real `pnpm pack` tarball.

## Feedback

Issues and pull requests are welcome: [https://github.com/JayYuen666/dsh-quality-gate/issues](https://github.com/JayYuen666/dsh-quality-gate/issues).

If a plugin fails to boot, include the dsh host version, the profile install shape, and the browser console line. The `missed the module table` line is especially useful: it tells us whether the shared client row was materialized.

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> License

MIT. Source at [github.com/JayYuen666/dsh-quality-gate](https://github.com/JayYuen666/dsh-quality-gate).

The mechanism is ported from ECC (MIT, © Affaan Mustafa) — running the project's own checks at turn end, and recording which files were edited. [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) records the upstream origin, what this package added on top of it, and the boundary of the runtime dependencies.
