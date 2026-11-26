/** 取错误的摘要文本（String(error) 对非 Error 会打出 [object Object]，所以在这里分类处理）。 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // 空 message 的 Error（`new Error()`）会把注入文案渲染成一对空括号；退回 String 至少留下 name。
    return error.message.length > 0 ? error.message : String(error);
  }
  if (typeof error === "string") {
    return error.length > 0 ? error : "unknown error";
  }
  // 宿主侧的错误不保证是 Error 实例（isSandboxUnavailable 就用字段读 code/name）：普通对象常带 message。
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return "unknown error";
}
