// test/log-templates.ts —— 本包算子可见日志的模板片段（手工维护）。
// 账本用它判「这条日志是不是源码里现存的模板」；新增 console.* 若没有对应片段，
// 跑测时那条日志就会被判未认领（见 test/setup-logs.ts）。这里不读盘：规则面
// （node/no-sync 等）不该为了测试脚手架开口子，且模板漂移应当是一次显式的改动。
// 维护约定：片段取自真实模板里足够特异的部分（`[quality-gate]` 前缀或冒号引导的
// 谓语）；被插值切碎的裸尾巴不收——账本按 `includes` 匹配，`"(attempt"` 一类尾巴
// 会把任何含相同字符序列的新日志误判成已认领；删改消息时同删对应片段。
export const LOG_TEMPLATES: readonly string[] = [
  ": followup failed:",
  ": gate batch failed:",
  ": give-up followup failed:",
  ": giving up after",
  ": injection skipped (",
  "save write failed:",
  "[quality-gate] ctx is missing the settings.describe/configure + inject/fiber surface; gate not armed",
  "[quality-gate] gate did not run:",
  "[quality-gate] gate passed under PARTIAL sandbox enforcement (",
  "[quality-gate] gate tool unavailable (exit",
  "[quality-gate] lessonLoop report failed:",
  "[quality-gate] memory feedback skipped:",
  "[quality-gate] no manifest within",
  "[quality-gate] session event read returned no window;",
  "[quality-gate] sessionProjections register failed, falling back to full scan:",
  "[quality-gate] sessionQuery service unavailable;",
  "[quality-gate] shell service unavailable; gates skipped (pass-through)",
  "[quality-gate] turn-stopping handler failed (gate skipped):",
  "edited file(s) evicted from accumulator cap; gate may miss their roots",
  "injected at turn",
  "levels of",
  "repair attempts (gate still failing)",
  "— reported as not-run",
];
