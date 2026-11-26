/** 只有一张引用计数表；单独抽出来是为了让「跨批次撞同一根」的递减有可直接测的分支。 */
interface GateRootCounter {
  activeGateRoots: Map<string, number>;
}

/**
 * 释放一个门禁根。计数降到 0 才删键；还有别的批次在跑时保留减一后的计数，
 * 否则后一个批次的 `busy` 探测会看到 0 而误放行。
 */
export function releaseGateRoot(counter: GateRootCounter, root: string): void {
  const count = counter.activeGateRoots.get(root) ?? 0;
  if (count <= 1) {
    counter.activeGateRoots.delete(root);
  } else {
    counter.activeGateRoots.set(root, count - 1);
  }
}
