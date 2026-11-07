// gateway-feedback 的对外行为测试：
// 从对外声明这一层验证「质量门禁→ 记忆网关」的反馈链路：
//   1. deriveAgentId：cwd → '尾目录名-8位hash'（与网关 workspace-peer 同分桶语义）；
//      非字符串/空/根路径 → 'default'；空白与重复斜杠归一化；尾部斜杠剥离；空格转 _。
//      分桶用的键实现在 shared/lib/project-key.ts（和 lesson-loop 的 project 来自同一处），这里只测
//      别名的契约，加上 resolve/realpath 归一之后的分桶结果。
//   2. buildFeedbackText：压成一行、格式契约、失败文本为空。
//   3. resolveGatewayUrl / resolveServiceId：URL 与 service id 都是**调用期**解析
//      （模块级常量会在 import 时固化 env，既让测试改 env 无效，也把作者机器上的
//      127.0.0.1:8420 塞给所有使用者）；默认值是"未配置"，不是任何具体地址。
//   4. pushGateFeedback：发送目标（url + key）由调用方传入（key 走 dsh 的凭据通道，
//      不再拼任何本机文件路径）；请求的契约（URL、方法、鉴权头、body、signal 超时）；
//      非 2xx 抛错。
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveProjectKey } from "@jayyuen66/dsh-plugin-shared/lib/project-key";
import { buildFeedbackText } from "../lib/feedback-content.ts";
import type { GateFeedbackInput } from "../lib/feedback-content.ts";
import { pushGateFeedback } from "../lib/gateway-feedback.ts";
import { deriveAgentId, resolveGatewayUrl, resolveServiceId } from "../lib/gateway-target.ts";
import { MESSAGES } from "../lib/messages.ts";

/** 一个 /tmp 下的 cwd夹具：macOS 上 realpath 会把它归一到 /private/tmp（软链接），
 *  分桶一致性的用例把它同时传给 deriveAgentId 和 deriveProjectKey。 */
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

  it("cwd 末段目录含空格 → 目录名空格转下划线", () => {
    // 空格必须落在被取用的那一段（尾目录名）：先前样例把空格放在中间段、断言只看
    // `^src-`，把「空格转 _」整段删掉也照样绿。
    const id = deriveAgentId("/repo/my project");
    assert.match(id, /^my_project-[0-9a-f]{8}$/u);
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
    // sep 一起注入：字形与 resolve 必须同源，否则非 POSIX runner 上 path.win32 会把
    // `/tmp/x/proj` 解析成带盘符的串，`viaSymlink` 的字面量替换一次都命不中，用例就变成
    // 在验「注入没生效」而不是「软链归一到同一桶」。
    const viaSymlink = {
      realpath: (target: string): string => target.replace("/tmp/", "/private/tmp/"),
      sep: "/",
    };
    assert.equal(
      deriveProjectKey(SYMLINKED_CWD, viaSymlink),
      deriveProjectKey("/private/tmp/x/proj", { sep: "/" }),
    );
  });

  it.skipIf(process.platform !== "darwin")(
    "真实软链目录归一到真实路径同一桶（macOS /var ↔ /private/var）",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "qg-bucket-"));
      try {
        const real = await realpath(dir);
        assert.equal(deriveAgentId(`${dir}/`), deriveAgentId(real));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("buildFeedbackText（失败摘要 → 记忆正文）", () => {
  it("格式契约：前缀带着命令与项目根，正文压成一行", () => {
    const text = buildFeedbackText(
      {
        command: ["pnpm", "check"],
        root: "/w/proj",
        failure: "line1\nline2  spaced\t\ttab",
      },
      MESSAGES.zh,
    );
    assert.equal(
      text,
      `[quality-gate 反馈] 门禁失败 pnpm check（根 /w/proj）：line1 line2 spaced tab\n${MESSAGES.zh.memoryEvidenceNotice}`,
    );
  });

  it("失败的文本为空 → 返回空串（不发送空记录）", () => {
    const text = buildFeedbackText(
      { command: ["cargo", "check"], root: "/x", failure: "   " },
      MESSAGES.zh,
    );
    assert.equal(text, "");
  });

  it("失败文本多换行压缩为单空格", () => {
    const text = buildFeedbackText(
      { command: ["tsc"], root: "/x", failure: "a\n\n\nb\n" },
      MESSAGES.zh,
    );
    assert.equal(
      text,
      `[quality-gate 反馈] 门禁失败 tsc（根 /x）：a b\n${MESSAGES.zh.memoryEvidenceNotice}`,
    );
  });

  it("运行时越过类型的非字符串失败文本 → 空串，不抛 TypeError", () => {
    // 类型上 failure 是 string，但这份内容由门禁的执行结果拼出来（spawn 失败、上游传下来的
    // undefined 都到得了这里）。抛异常的后果是整条记忆不写、日志只说"skipped"，看不出原因。
    const bad = {
      command: ["tsc"],
      root: "/x",
      failure: undefined,
    } as unknown as GateFeedbackInput;
    const text = buildFeedbackText(bad, MESSAGES.zh);
    assert.equal(text, "");
  });

  it("运行时越过类型的非数组命令 → 按空数组处理，不抛 join TypeError", () => {
    const bad = {
      command: undefined,
      root: "/x",
      failure: "e",
    } as unknown as GateFeedbackInput;
    const text = buildFeedbackText(bad, MESSAGES.zh);
    assert.equal(
      text,
      `[quality-gate 反馈] 门禁失败 （根 /x）：e\n${MESSAGES.zh.memoryEvidenceNotice}`,
    );
  });

  it("命令与根里的换行同样换成空格：模板正文始终是一行", () => {
    const text = buildFeedbackText(
      { command: ["pnpm", "--filter", "a\nb"], root: "/w/\nproj", failure: "f" },
      MESSAGES.zh,
    );
    const rendered = "[quality-gate 反馈] 门禁失败 pnpm --filter a b（根 /w/ proj）：f";
    assert.equal(text, `${rendered}\n${MESSAGES.zh.memoryEvidenceNotice}`);
  });

  it("记忆正文语言取自字典：en 表渲染同一事实（后续会话召回的就是这条）", () => {
    const input = { command: ["pnpm", "check"], root: "/w/proj", failure: "TS2345: type error" };
    assert.equal(
      buildFeedbackText(input, MESSAGES.en),
      `[quality-gate feedback] gate failure pnpm check (root /w/proj): TS2345: type error\n${MESSAGES.en.memoryEvidenceNotice}`,
    );
    assert.doesNotMatch(
      buildFeedbackText(input, MESSAGES.en),
      /反馈|门禁失败/u,
      "英文正文不残留中文",
    );
  });
});

describe("resolveGatewayUrl（网关地址：先看设置，再看 env 变量，默认未配置）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("设置里有值 → 用设置值（env 同时设了也不越权：设置卡是显式配置表）", () => {
    vi.stubEnv("TDAI_GATEWAY_URL", "http://stale.invalid:8420");
    assert.equal(resolveGatewayUrl("http://127.0.0.1:9999"), "http://127.0.0.1:9999");
  });

  it("设置为空 + env 有值 → env 兜底生效（这是给插件作者留的备用配置，不再是任何人的默认地址）", () => {
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

  it("带 query / fragment 的串 → 空串（返回值是基址，拼 /v2/… 会落到 query 之后）", () => {
    vi.stubEnv("TDAI_GATEWAY_URL", undefined);
    // 原样透传的后果：`https://gw/api?x=1` + `/v2/conversation/add`
    // = `https://gw/api?x=1/v2/conversation/add`，请求打到一个不存在的 query 上。
    // 那看起来像网关 404，实际是配置把基址写成了完整请求地址。
    assert.equal(resolveGatewayUrl("https://gw.example/api?x=1"), "");
    assert.equal(resolveGatewayUrl("https://gw.example/api#frag"), "");
    assert.equal(resolveGatewayUrl("http://127.0.0.1:8420/?a=b"), "");
  });

  it("带 userinfo 的串 → 空串（基址不是存密钥的地方，且它会进降级日志）", () => {
    vi.stubEnv("TDAI_GATEWAY_URL", undefined);
    // host 的降级 reason 会插值这个返回值：原样透传等于把 settings.yaml 里的密码
    // 打进日志与用户可见的提示。凭据只能走 memoryGatewayKeyRef（引用名）。
    assert.equal(resolveGatewayUrl("http://user:pass@gw.internal:8420"), "");
    assert.equal(resolveGatewayUrl("https://token@gateway.example.com"), "");
  });

  it("剥斜杠后才解析不开的半截串 → 空串（不把配置手滑当成协议不安全）", () => {
    vi.stubEnv("TDAI_GATEWAY_URL", undefined);
    // `http://` 剥完是 `http:`：原样透出去会被 isCredentialSafeUrl 判成"明文 http 且非回环"，
    // 用户从一个错误的提示里根本看不出真正的成因其实是 URL 写残了。
    assert.equal(resolveGatewayUrl("http://"), "");
    assert.equal(resolveGatewayUrl("gateway.internal:8420"), "");
    assert.equal(resolveGatewayUrl("   https://  "), "");
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

describe("pushGateFeedback（写入记忆那一步的请求契约）", () => {
  let calls: { url: string; init: Record<string, unknown> }[];
  /** 发送目标由调用方（host：设置 + ctx.credentials + x-tdai-service-id）解析之后传入：
   *  本模块既不拼默认地址，也不读 env——服务名走 target 而不是自己再算一遍。 */
  const BASE = "https://gateway.test:8420";
  const target = { url: BASE, key: "tok-abc", serviceId: "dsh-test" };

  beforeEach(() => {
    calls = [];
    // 故意取一个和 target.serviceId 不同的值：发送方若偷偷读 env，对应的用例就会当场失败。
    vi.stubEnv("TDAI_SERVICE_ID", "env-should-not-be-used");
    // stubGlobal 而不是手工保存/恢复 globalThis.fetch：后者在赋值之后抛错时会把伪件
    // 泄漏给后续用例，也与本文件 vi.stubEnv 的回收风格不一致。
    vi.stubGlobal("fetch", async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("请求的契约：POST {url}/v2/conversation/add + Bearer key + body 结构 + 5 秒超时的 signal", async () => {
    // 超时这条契约要断言到具体数值：只断言 signal 是 AbortSignal 实例时，把 5 秒改成 1 秒也照样通过。
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
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
      assert.equal(timeoutSpy.mock.calls[0]?.[0], 5000, "发送反馈的超时固定 5 秒");
    } finally {
      timeoutSpy.mockRestore();
    }
    assert.equal(calls.length, 1);
    const [firstCall] = calls;
    assert.ok(firstCall, "应有一次请求记录");
    const { url, init } = firstCall;
    // 地址完全来自入参：这个库里不存在任何"作者机器上的网关"这类兜底值
    assert.equal(url, `${BASE}/v2/conversation/add`);
    assert.equal(init["method"], "POST");
    const headers = init["headers"] as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer tok-abc");
    // 服务名取 target.serviceId，不取 env：beforeEach 故意把 TDAI_SERVICE_ID 设成另一个值，
    // 这里仍必须用 target 里那个——否则「发送目标由调用方解析」这条契约就是空话。
    assert.equal(headers["x-tdai-service-id"], "dsh-test");
    const body = JSON.parse(init["body"] as string) as {
      session_id: string;
      agent_id: string;
      messages: { role: string; content: string }[];
    };
    assert.equal(body.session_id, "dsh-agent");
    assert.match(body.agent_id, /^proj-[0-9a-f]{8}$/u);
    assert.equal(body.messages.length, 1);
    // 与上面 firstCall 同一写法：先按类型声明把「有一条消息」坐实，再取必填字段。
    // （`body.messages[0]?.content` 那种写法把下标访问当成可空值来守卫，实测
    //   oxlint 的 no-unnecessary-condition 与 tsc 对下标可空性的判定并不一致，
    //   删守卫/留守卫都会撞上一边的门；显式收窄两侧都认。）
    const [firstMessage] = body.messages;
    assert.ok(firstMessage, "写入记忆的请求必须带一条消息");
    assert.equal(firstMessage.role, "assistant");
    assert.match(firstMessage.content, /TS2345/u);
    assert.ok((init["signal"] as AbortSignal) instanceof AbortSignal);
  });

  it("网关非 2xx → 抛错（带状态码），且先消费掉响应体再抛", async () => {
    let drained = false;
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 502,
      headers: { get: () => null },
      arrayBuffer: async () => {
        drained = true;
        return new ArrayBuffer(0);
      },
    }));
    await assert.rejects(
      pushGateFeedback(
        { cwd: "/x", command: ["tsc"], root: "/x", failure: "e" },
        { url: BASE, key: "k", serviceId: "default" },
        MESSAGES.zh,
      ),
      /HTTP 502/u,
    );
    // 未消费的 2xx 之外的响应体会让 undici 把该连接留在 keep-alive 槽位里直到超时；
    // 顺序反过来（先 throw 再 drain）这条断言就红。
    assert.equal(drained, true, "抛错前必须先读掉响应体");
  });

  it("非 2xx 且响应体有正文 → 错误信息带上截断后的正文（401 与 400 的修法不同）", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 401,
      headers: { get: () => "text/plain" },
      arrayBuffer: async () => new TextEncoder().encode("  invalid token  ").buffer,
    }));
    await assert.rejects(
      pushGateFeedback(
        { cwd: "/x", command: ["tsc"], root: "/x", failure: "e" },
        { url: BASE, key: "k", serviceId: "default" },
        MESSAGES.zh,
      ),
      /HTTP 401：invalid token$/u,
    );
  });

  it("非 2xx 且响应体读不出来 → 仍只带状态码，不因此改变抛错形态", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      arrayBuffer: async () => {
        throw new Error("body stream reset");
      },
    }));
    await assert.rejects(
      pushGateFeedback(
        { cwd: "/x", command: ["tsc"], root: "/x", failure: "e" },
        { url: BASE, key: "k", serviceId: "default" },
        MESSAGES.zh,
      ),
      /^Error: gateway feedback HTTP 503$/u,
    );
  });

  it("发送目标不完整（空 url、空 key）→ 在发请求之前就抛错，且不联网", async () => {
    const callsBefore = calls.length;
    await assert.rejects(
      pushGateFeedback(
        { cwd: "/w", command: ["tsc"], root: "/w", failure: "e" },
        { url: "   ", key: "k", serviceId: "default" },
        MESSAGES.zh,
      ),
      /投递目标不完整/u,
    );
    await assert.rejects(
      pushGateFeedback(
        { cwd: "/w", command: ["tsc"], root: "/w", failure: "e" },
        { url: `${BASE}/`, key: "", serviceId: "default" },
        MESSAGES.zh,
      ),
      /投递目标不完整/u,
    );
    assert.equal(
      calls.length,
      callsBefore,
      "校验不过就不许发请求：把 fetch 的底层 TypeError 抛给上层不可诊断",
    );
  });

  it("明文 http 指向非回环 → 发请求之前拒投（凭据不上网）", async () => {
    const callsBefore = calls.length;
    await assert.rejects(
      pushGateFeedback(
        { cwd: "/w", command: ["tsc"], root: "/w", failure: "e" },
        { url: "http://gateway.test:8420", key: "k", serviceId: "default" },
        MESSAGES.zh,
      ),
      /投递目标不安全/u,
    );
    assert.equal(calls.length, callsBefore, "不安全的目标必须在 fetch 之前被拦下");
  });

  it("非法 serviceId → 回落 default，而不是发出畸形请求头", async () => {
    await pushGateFeedback(
      { cwd: "/w", command: ["tsc"], root: "/w", failure: "e" },
      { url: BASE, key: "k", serviceId: "bad service\nid" },
      MESSAGES.zh,
    );
    const [firstCall] = calls;
    const headers = firstCall?.init["headers"] as Record<string, string>;
    assert.equal(headers["x-tdai-service-id"], "default");
  });

  it("无法解析的基址 → 发请求之前拒投", async () => {
    await assert.rejects(
      pushGateFeedback(
        { cwd: "/w", command: ["tsc"], root: "/w", failure: "e" },
        { url: "not a url", key: "k", serviceId: "default" },
        MESSAGES.zh,
      ),
      /投递目标不完整/u,
    );
  });

  it("非 http(s) 协议、带 query/fragment 的基址 → 发请求之前拒投", async () => {
    const callsBefore = calls.length;
    const urls = [
      "ftp://gateway.test:21",
      "https://gateway.test/api?x=1",
      "https://gateway.test/api#frag",
    ];
    await Promise.all(
      urls.map((url) =>
        assert.rejects(
          pushGateFeedback(
            { cwd: "/w", command: ["tsc"], root: "/w", failure: "e" },
            { url, key: "k", serviceId: "default" },
            MESSAGES.zh,
          ),
          /投递目标不完整/u,
        ),
      ),
    );
    assert.equal(calls.length, callsBefore, "基址不合法时不许发请求");
  });

  it("失败的正文为空 → 不发送（空记录只会成为之后召回时的干扰内容）", async () => {
    const callsBefore = calls.length;
    await pushGateFeedback(
      { cwd: "/w", command: ["tsc"], root: "/w", failure: "   " },
      target,
      MESSAGES.zh,
    );
    assert.equal(calls.length, callsBefore, "空正文不发请求");
  });

  it("尾部斜杠归一：target.url 带 / 时不拼出 //v2/…", async () => {
    await pushGateFeedback(
      { cwd: "/w", command: ["tsc"], root: "/w", failure: "e" },
      { url: `${BASE}/`, key: "k", serviceId: "default" },
      MESSAGES.zh,
    );
    const [firstCall] = calls;
    assert.equal(firstCall?.url, `${BASE}/v2/conversation/add`);
  });

  it("响应体读取失败不影响「已送达」结论（body 消费只是连接复用）", async () => {
    vi.stubGlobal("fetch", async (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          throw new Error("body stream reset");
        },
      };
    });
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
