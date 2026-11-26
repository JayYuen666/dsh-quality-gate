// src/remote.ts —— 会话侧栏读最近门禁结果的远程读取面（官方 Typert Remote 的消费侧）。
//
// descriptor 手写（来源模式要求）、请求走 strict 形状校验、结果走 src-json。`remote` 是
// 可选服务：没有它时会话面板的开关格照旧，结果格显示「本会话尚无记录」。
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/client";
import { isRemoteMounter } from "@jayyuen66/dsh-plugin-shared/lib/typert-client";
import type { RemoteHost, RemoteMounter } from "@jayyuen66/dsh-plugin-shared/lib/typert-client";
import { z } from "zod";

/** Typert Remote 命名空间。宿主半的注册键在 host.ts 的 `QUALITY_GATE_NAMESPACE`；
 *  client 包不能 import host.ts，这一枚字面量因此有两份，取值必须一致。 */
export const QUALITY_GATE_NAMESPACE = "qualityGate";
const SERVICE_KEY = `remote.${QUALITY_GATE_NAMESPACE}`;
const PACKAGE_NAME = "@jayyuen66/dsh-quality-gate";

const STATE_MESSAGE = "state request requires a string sessionId";
const STATE_SCHEMA = z.object(
  { sessionId: z.string({ error: STATE_MESSAGE }) },
  { error: STATE_MESSAGE },
);

const STATE_CODEC: TypertCodec<{ sessionId: string }> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#gate-state-request`,
  create: () => ({
    parse(value: unknown): { sessionId: string } {
      const parsed = STATE_SCHEMA.safeParse(value);
      if (!parsed.success) {
        throw new TypeError(z.prettifyError(parsed.error));
      }
      return parsed.data;
    },
  }),
};

/** run 与 state 共用 sessionId 的请求形状；线上类型标识各用一枚，排查网关日志时才分得清两种调用。 */
const RUN_CODEC: TypertCodec<{ sessionId: string }> = {
  ...STATE_CODEC,
  typeSymbol: `${PACKAGE_NAME}#gate-run-request`,
};

export const QUALITY_GATE_DESCRIPTORS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${QUALITY_GATE_NAMESPACE}/latest`,
    service: QUALITY_GATE_NAMESPACE,
    namespace: QUALITY_GATE_NAMESPACE,
    method: "latest",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${QUALITY_GATE_NAMESPACE}/run`,
    service: QUALITY_GATE_NAMESPACE,
    namespace: QUALITY_GATE_NAMESPACE,
    method: "run",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: RUN_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${QUALITY_GATE_NAMESPACE}/state`,
    service: QUALITY_GATE_NAMESPACE,
    namespace: QUALITY_GATE_NAMESPACE,
    method: "state",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: STATE_CODEC }],
    result: { mode: "src-json" },
  },
];

/** 一条门禁结果（宿主侧的行形状，客户端只读这几个字段）。 */
export interface GateDiagnostic {
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

export interface GateResultRow {
  readonly at: number;
  readonly gate: string;
  readonly root: string;
  readonly outcome: "pass" | "code-failure" | "not-run";
  readonly detail: string;
  /** 行诊断；没有诊断或输出认不出时缺席。 */
  readonly diagnostics?: readonly GateDiagnostic[];
}

export interface QualityGateState {
  readonly sessionId: string;
  readonly rows: readonly GateResultRow[];
}

export interface QualityGateReader {
  /** 本会话最近的结果行（没有就是 undefined）。 */
  latest: () => Promise<GateResultRow | undefined>;
  state: (sessionId: string) => Promise<QualityGateState>;
  /** 立即跑一次该会话项目的门禁；返回宿主的状态词（done / busy / no-gate …）。 */
  run: (sessionId: string) => Promise<string>;
}

interface QualityGateNamespace {
  latest: () => Promise<RemoteResult<unknown>>;
  run: (request: { sessionId: string }) => Promise<RemoteResult<unknown>>;
  state: (request: { sessionId: string }) => Promise<RemoteResult<unknown>>;
}

const isNamespace = (value: unknown): value is QualityGateNamespace =>
  isRecord(value) &&
  typeof value["latest"] === "function" &&
  typeof value["state"] === "function" &&
  typeof value["run"] === "function";

const unwrap = (raw: unknown): unknown => {
  if (!isRecord(raw) || typeof raw["ok"] !== "boolean") {
    throw new TypeError("Typert Remote 应答不是 RemoteResult：缺少布尔字段 ok");
  }
  if (!raw["ok"]) {
    const { error } = raw;
    if (
      !isRecord(error) ||
      typeof error["code"] !== "string" ||
      typeof error["message"] !== "string"
    ) {
      throw new TypeError("Typert Remote 应答的 error 分支缺 code/message");
    }
    throw new Error(`${error["code"]}: ${error["message"]}`);
  }
  if (!("value" in raw)) {
    throw new TypeError("Typert Remote 应答的 ok 分支缺 value 字段");
  }
  return raw["value"];
};

/** 逐条验诊断形状，坏条目丢掉。 */
function diagnosticsOf(value: unknown): GateDiagnostic[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): GateDiagnostic[] =>
    isRecord(item) &&
    typeof item["path"] === "string" &&
    typeof item["line"] === "number" &&
    typeof item["message"] === "string"
      ? [{ path: item["path"], line: item["line"], message: item["message"] }]
      : [],
  );
}

/** 一行应答是不是本包的 GateResultRow；不是就返回 undefined（坏行丢掉，不猜）。 */
function parseRow(row: unknown): GateResultRow | undefined {
  let parsed: GateResultRow | undefined;
  if (isRecord(row)) {
    const { at, gate, root, detail, outcome } = row;
    const known =
      typeof at === "number" &&
      typeof gate === "string" &&
      typeof root === "string" &&
      typeof detail === "string" &&
      (outcome === "pass" || outcome === "code-failure" || outcome === "not-run");
    const diagnostics = known ? diagnosticsOf(row["diagnostics"]) : [];
    parsed = known
      ? { at, gate, root, detail, outcome, ...(diagnostics.length === 0 ? {} : { diagnostics }) }
      : undefined;
  }
  return parsed;
}

/** 把应答收成客户端认识的行形状：跨进程边界的东西不归声明保证，坏行直接丢掉。 */
function stateOf(value: unknown, sessionId: string): QualityGateState {
  const rows =
    isRecord(value) && Array.isArray(value["rows"])
      ? value["rows"].flatMap((row): GateResultRow[] => {
          const parsed = parseRow(row);
          return parsed === undefined ? [] : [parsed];
        })
      : [];
  return { sessionId, rows };
}

function buildReader(ctx: RemoteHost, remote: RemoteMounter): QualityGateReader {
  let mounted: Promise<unknown> | undefined;
  const namespaceOf = async (): Promise<QualityGateNamespace> => {
    mounted ??= remote.$mount({ package: PACKAGE_NAME, descriptors: QUALITY_GATE_DESCRIPTORS });
    try {
      await mounted;
    } catch (error) {
      mounted = undefined;
      throw error;
    }
    const namespace = ctx.get?.(SERVICE_KEY, false);
    if (!isNamespace(namespace)) {
      throw new Error(`${SERVICE_KEY} 未提供：宿主网关没有挂上这枚命名空间`);
    }
    return namespace;
  };
  return {
    latest: async () => {
      const namespace = await namespaceOf();
      const value = unwrap(await namespace.latest());
      return isRecord(value) ? parseRow(value["row"]) : undefined;
    },
    run: async (sessionId) => {
      const namespace = await namespaceOf();
      const value = unwrap(await namespace.run({ sessionId }));
      return isRecord(value) && typeof value["status"] === "string" ? value["status"] : "unknown";
    },
    state: async (sessionId) => {
      const namespace = await namespaceOf();
      return stateOf(unwrap(await namespace.state({ sessionId })), sessionId);
    },
  };
}

/** 造读取器；当前部署没有远程通道时 undefined（面板只显示开关）。 */
export function createQualityGateReader(ctx: RemoteHost): QualityGateReader | undefined {
  let remote: unknown;
  try {
    remote = ctx.get?.("remote", false);
  } catch {
    remote = undefined;
  }
  return isRemoteMounter(remote) ? buildReader(ctx, remote) : undefined;
}
