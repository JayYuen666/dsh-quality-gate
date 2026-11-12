// test/log-templates.ts —— 本包写出的日志的模板片段（手工维护）。
// 记录清单用它判断"这条日志是不是源码里已有的模板"；新增的 console.* 如果没有对应的片段，
// 跑测试时那条日志就会被算作无人认领（见 test/setup-logs.ts）。这里不读文件：lint 规则
// （node/no-sync 等）不该为测试辅助代码破例，而且模板发生变化应当是一次明确的改动。
// 维护约定：片段取自真实模板里足够特别的这部分（`[quality-gate]` 开头，或者冒号引出的
// 动词）；被插值切断的尾巴不收——记录清单按 `includes` 匹配，`"(attempt"` 一类尾巴
// 会把任何包含相同字符序列的新日志误判成已认领；删除或修改消息时把对应片段一起处理掉。
export const LOG_TEMPLATES: readonly string[] = Object.freeze([
  ": followup failed:",
  ": gate batch failed:",
  ": give-up followup failed:",
  ": giving up after",
  ": injection skipped (",
  ": gate deferred; teammate(s) still running:",
  "agents service unavailable;",
  "save write failed:",
  "subagent listing unavailable; teammate edits are not aggregated:",
  "teammate edit read failed; its files are not aggregated:",
  "writable-root registration failed for",
  "writable-root release failed:",
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
]);
