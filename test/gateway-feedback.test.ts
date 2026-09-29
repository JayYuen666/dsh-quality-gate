// gateway-feedback 契约测试（2026-09-18 补齐，此前覆盖率仅 54%）：
// 从对外契约验证质量门禁 → 记忆网关的反馈链：
//   1. deriveAgentId：cwd → '尾目录名-8位hash'（与网关 workspace-peer 同分桶语义）；
//      非字符串/空/根路径 → 'default'；空白与重复斜杠归一化；尾部斜杠剥离；空格转 _。
//      桶键实现在 shared/lib/project-key.ts（与 lesson-loop 的 project 同源），本处只测
//      别名契约 + resolve/realpath 归一后的分桶结果。
//   2. buildFeedbackText：单行化、格式契约、空失败文本。
//   3. resolveGatewayUrl / resolveServiceId：URL 与 service id 都是**调用期**解析
//      （模块级常量会在 import 时固化 env，既让测试改 env 无效，也把作者机器上的
//      127.0.0.1:8420 塞给所有使用者）；默认值是"未配置"，不是任何具体地址。
//   4. pushGateFeedback：投递目标（url + key）由调用方传入（key 走 dsh 凭据通道，
//      不再拼任何本机文件路径）；请求契约（URL/方法/鉴权头/body/signal 超时）；
//      非 2xx 抛错。
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveProjectKey } from "@jayyuen666/dsh-plugin-shared/lib/project-key";
import { buildFeedbackText } from "../lib/feedback-content.ts";
import { pushGateFeedback } from "../lib/gateway-feedback.ts";
import { deriveAgentId, resolveGatewayUrl, resolveServiceId } from "../lib/gateway-target.ts";
import { MESSAGES } from "../lib/messages.ts";

/** 一个 /tmp 下的 cwd 夹具：macOS 上 realpath 会把它归一到 /private/tmp（软链），
 *  分桶一致性用例拿它同时喂给 deriveAgentId 与 deriveProjectKey。 */
const SYMLINKED_CWD = "/tmp/x/proj";

describe("deriveAgentId（cwd → 记忆桶）", () => {
  it("正常 cwd → 尾目录名-8位sha256", () => {
    const id = deriveAgentId("/Users/me/work/my-project");
    assert.match(id, /^my-project-[0-9a-f]{8}$/u);
  });

  it("非字符串/空串/根路径 → default", () => {
    assert.equal(deriveAgentId(undefined), "default");
    assert.equal(deriveAgentId(null), "default");
    assert.equal(deriveAgentId(42), "default");
    assert.equal(deriveAgentId(""), "default");
    assert.equal(deriveAgentId("   "), "default");
    assert.equal(deriveAgentId("/"), "default");
  });

  it("重复斜杠与尾部斜杠归一化，且归一化不改变桶", () => {
    const derivedA = deriveAgentId("/repo/proj//src///");
    const derivedB = deriveAgentId("/repo/proj/src");
    assert.equal(derivedA, derivedB);
    assert.match(derivedA, /^src-[0-9a-f]{8}$/u);
  });

  it("cwd 含空格 → 目录名空格转下划线", () => {
    const id = deriveAgentId("/repo/my project/src");
    assert.match(id, /^src-[0-9a-f]{8}$/u);
  });

  it("同一 cwd 幂等（多次调用同键）", () => {
    const cwd = "/w/proj/backend";
    assert.equal(deriveAgentId(cwd), deriveAgentId(cwd));
  });

  it("桶键来自 shared 单一实现：与 deriveProjectKey 同结果", () => {
    // lesson-loop 的 project 与这里的 agent_id 必须是同一个函数算出来的——两处各存一份
    // 时改一处漏一处，教训与网关记忆就会分进不同桶。
    assert.equal(deriveAgentId(SYMLINKED_CWD), deriveProjectKey(SYMLINKED_CWD));
    assert.equal(deriveAgentId(42), deriveProjectKey(42));
    const viaSymlink = {
      realpath: (target: string): string => target.replace("/tmp/", "/private/tmp/"),
    };
    assert.equal(
      deriveProjectKey(SYMLINKED_CWD, viaSymlink),
      deriveProjectKey("/private/tmp/x/proj"),
    );
  });

  it("真实软链目录归一到真实路径同一桶（macOS /var ↔ /private/var）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qg-bucket-"));
    try {
      const real = await realpath(dir);
      assert.equal(deriveAgentId(`${dir}/`), deriveAgentId(real));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildFeedbackText（失败摘要 → 记忆正文）", () => {
  it("格式契约：前缀含命令与根，正文单行化", () => {
    const text = buildFeedbackText(
      {
        command: ["pnpm", "check"],
        root: "/w/proj",
        failure: "line1\nline2  spaced\t\ttab",
      },
      MESSAGES.zh,
    );
    assert.match(
      text,
      /^\[quality-gate 反馈\] 门禁失败 pnpm check（根 \/w\/proj）：line1 line2 spaced tab$/u,
    );
  });

  it("空失败文本 → 前缀 + 空正文", () => {
    const text = buildFeedbackText(
      { command: ["cargo", "check"], root: "/x", failure: "   " },
      MESSAGES.zh,
    );
    assert.match(text, /：$/u);
  });

  it("失败文本多换行压缩为单空格", () => {
    const text = buildFeedbackText(
      { command: ["tsc"], root: "/x", failure: "a\n\n\nb\n" },
      MESSAGES.zh,
    );
    assert.equal(text, "[quality-gate 反馈] 门禁失败 tsc（根 /x）：a b");
  });

  it("记忆正文语言取自字典：en 表渲染同一事实（后续会话召回的就是这条）", () => {
    const input = { command: ["pnpm", "check"], root: "/w/proj", failure: "TS2345: type error" };
    assert.equal(
      buildFeedbackText(input, MESSAGES.en),
      "[quality-gate feedback] gate failure pnpm check (root /w/proj): TS2345: type error",
    );
    assert.doesNotMatch(
      buildFeedbackText(input, MESSAGES.en),
      /反馈|门禁失败/u,
      "英文正文不残留中文",
    );
  });
});

describe("resolveGatewayUrl（网关基址：设置优先，env 兜底，默认未配置）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("设置里有值 → 用设置值（env 同时设了也不越权：设置卡是显式配置面）", () => {
    vi.stubEnv("TDAI_GATEWAY_URL", "http://stale.invalid:8420");
    assert.equal(resolveGatewayUrl("http://127.0.0.1:9999"), "http://127.0.0.1:9999");
  });

  it("设置为空 + env 有值 → env 兜底生效（作者的逃生门，不再是任何人的默认值）", () => {
    vi.stubEnv("TDAI_GATEWAY_URL", " http://gateway.internal:8420 ");
    assert.equal(resolveGatewayUrl(""), "http://gateway.internal:8420");
  });

  it("设置与 env 都为空 → 空串（= 未配置，调用方据此不启用记忆反馈）", () => {
    vi.stubEnv("TDAI_GATEWAY_URL", undefined);
    assert.equal(resolveGatewayUrl(""), "");
    vi.stubEnv("TDAI_GATEWAY_URL", "   ");
    assert.equal(resolveGatewayUrl("   "), "");
  });

  it("尾部斜杠剥离（避免拼出 //v2/… 的 404）", () => {
    vi.stubEnv("TDAI_GATEWAY_URL", undefined);
    assert.equal(resolveGatewayUrl("http://127.0.0.1:8420///"), "http://127.0.0.1:8420");
  });
});

describe("resolveServiceId（x-tdai-service-id：调用期读 env，默认协议值）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("env 未设 → 'default'（网关协议的服务实例默认名，不含任何机器信息）", () => {
    vi.stubEnv("TDAI_SERVICE_ID", undefined);
    assert.equal(resolveServiceId(), "default");
  });

  it("env 只有空白 → 仍按未设处理（不把空白当服务名送进请求头）", () => {
    vi.stubEnv("TDAI_SERVICE_ID", "   ");
    assert.equal(resolveServiceId(), "default");
  });

  it("env 有值 → trim 后用之（每次调用都重读，import 期不固化）", () => {
    vi.stubEnv("TDAI_SERVICE_ID", "  svc-a  ");
    assert.equal(resolveServiceId(), "svc-a");
    vi.stubEnv("TDAI_SERVICE_ID", "svc-b");
    assert.equal(resolveServiceId(), "svc-b");
  });
});

describe("pushGateFeedback（L0 沉淀请求契约）", () => {
  let calls: { url: string; init: Record<string, unknown> }[];
  let originalFetch: typeof globalThis.fetch;
  /** 投递目标由调用方（host：设置 + ctx.credentials）解析后传入，本模块不再自带默认地址。 */
  const target = { url: "http://gateway.test:8420", key: "tok-abc" };

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    vi.stubEnv("TDAI_SERVICE_ID", "dsh-test");
    (globalThis as unknown as Record<string, unknown>)["fetch"] = async (
      url: string,
      init: Record<string, unknown>,
    ) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    (globalThis as unknown as Record<string, unknown>)["fetch"] = originalFetch;
  });

  it("请求契约：POST {url}/v2/conversation/add + Bearer key + body 结构 + 5s 超时 signal", async () => {
    await pushGateFeedback(
      {
        cwd: "/w/proj",
        command: ["pnpm", "check"],
        root: "/w/proj",
        failure: "TS2345: type error",
      },
      target,
      MESSAGES.zh,
    );
    assert.equal(calls.length, 1);
    const [firstCall] = calls;
    assert.ok(firstCall, "应有一次请求记录");
    const { url, init } = firstCall;
    // 地址完全来自入参：库里不存在任何"作者机器的网关"兜底
    assert.equal(url, "http://gateway.test:8420/v2/conversation/add");
    assert.equal(init["method"], "POST");
    const headers = init["headers"] as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer tok-abc");
    assert.equal(headers["x-tdai-service-id"], "dsh-test");
    const body = JSON.parse(init["body"] as string) as {
      session_id: string;
      agent_id: string;
      messages: { role: string; content: string }[];
    };
    assert.equal(body.session_id, "dsh-agent");
    assert.match(body.agent_id, /^proj-[0-9a-f]{8}$/u);
    assert.equal(body.messages.length, 1);
    // 与上面 firstCall 同一写法：先按声明面把「有一条消息」坐实，再取必填字段。
    // （`body.messages[0]?.content` 那种写法把下标访问当成可空面来守卫，实测
    //   oxlint 的 no-unnecessary-condition 与 tsc 对下标可空性的判定并不一致，
    //   删守卫/留守卫都会撞上一边的门；显式收窄两侧都认。）
    const [firstMessage] = body.messages;
    assert.ok(firstMessage, "沉淀请求必须带一条消息");
    assert.equal(firstMessage.role, "assistant");
    assert.match(firstMessage.content, /TS2345/u);
    assert.ok((init["signal"] as AbortSignal) instanceof AbortSignal);
  });

  it("网关非 2xx → 抛错（带状态码）", async () => {
    (globalThis as unknown as Record<string, unknown>)["fetch"] = async () => ({
      ok: false,
      status: 502,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await assert.rejects(
      pushGateFeedback(
        { cwd: "/x", command: ["tsc"], root: "/x", failure: "e" },
        { url: "http://gateway.test:8420", key: "k" },
        MESSAGES.zh,
      ),
      /HTTP 502/u,
    );
  });

  it("响应体读取失败不影响「已送达」结论（body 消费只是连接复用）", async () => {
    (globalThis as unknown as Record<string, unknown>)["fetch"] = async (
      url: string,
      init: Record<string, unknown>,
    ) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          throw new Error("body stream reset");
        },
      };
    };
    await pushGateFeedback(
      {
        cwd: "/w/proj",
        command: ["pnpm", "check"],
        root: "/w/proj",
        failure: "TS2345",
      },
      target,
      MESSAGES.zh,
    );
    assert.equal(calls.length, 1, "请求已发出且不再抛错");
  });
});
