import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { releaseGateRoot } from "../lib/gate-roots.ts";

describe("门禁根引用计数", () => {
  it("最后一个批次释放时删键", () => {
    const counter = { activeGateRoots: new Map([["/p", 1]]) };
    releaseGateRoot(counter, "/p");
    assert.equal(counter.activeGateRoots.has("/p"), false);
    releaseGateRoot(counter, "/p");
    assert.equal(counter.activeGateRoots.has("/p"), false, "没有计数时也不留下 0");
  });

  it("还有别的批次在跑时只减一", () => {
    const counter = { activeGateRoots: new Map([["/p", 3]]) };
    releaseGateRoot(counter, "/p");
    assert.equal(counter.activeGateRoots.get("/p"), 2);
    releaseGateRoot(counter, "/p");
    assert.equal(counter.activeGateRoots.get("/p"), 1);
    releaseGateRoot(counter, "/p");
    assert.equal(counter.activeGateRoots.has("/p"), false);
  });
});
