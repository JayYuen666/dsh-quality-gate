// test/log-templates.ts —— 本包算子可见日志的模板片段（由源码扫出，勿手改）。
// 账本用它判「这条日志是不是源码里现存的模板」；新增 console.* 若没有对应片段，
// 跑测时那条日志就会被判未认领（见 test/setup-logs.ts）。这里不读盘：规则面
// （node/no-sync 等）不该为了测试脚手架开口子，且模板漂移应当是一次显式的改动。
export const LOG_TEMPLATES: readonly string[] = [
  "(attempt",
  ") at turn",
  ": followup failed:",
  ": gate batch failed:",
  ": give-up followup failed:",
  ": giving up after",
  ": injection skipped (",
  "; gate skipped for it",
  "[quality-gate] ctx is missing the settings.describe/configure + inject/fiber surface; gate not armed",
  "[quality-gate] gate did not run:",
  "[quality-gate] gate passed under PARTIAL sandbox enforcement (",
  "[quality-gate] gate tool unavailable (exit",
  "[quality-gate] gate tool unavailable (npx fetched a stub instead of the real tool):",
  "[quality-gate] lessonLoop report failed:",
  "[quality-gate] memory feedback skipped:",
  "[quality-gate] no manifest within",
  "[quality-gate] shell service unavailable; gates skipped (pass-through)",
  "[quality-gate] turn-stopping handler failed (gate skipped):",
  "edited file(s) evicted from accumulator cap; gate may miss their roots",
  "injected at turn",
  "levels of",
  "repair attempts (gate still failing)",
  "— reported as not-run",
  "— reported as not-run, not as pass",
];
