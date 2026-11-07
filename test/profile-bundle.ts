// test/profile-bundle.ts —— 核对卡片槽位 key 有没有写错（多个包共用，每个包一份副本，和 client-freshness.ts 一样）。
//
// 背景：`plugins.bundle.config` 是**按 bundle 包名**
// keyed 的槽位，宿主分发时拿注册项的 key 与这个 bundle 的包名做精确相等比较：
//   installed dsh-client-ui-plugin-manager/lib/client.js:2907
//     renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })
//   installed dsh-client-ui-renderer/lib/client.js:1179
//     host.entriesOfSlot(slotKey).find((e) => e.options.key === opts?.entryKey)
//   同一个插件页 :3979 上"这个 bundle 有没有配置卡"那一位 = ledger.bundles.has(openPkg.name)，
//   而 ledger.bundles 就是上面那批注册 key 的集合（:62 `keysOf("plugins.bundle.config")`）
//   installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:112-116
//     —— "keyed by the bundle's package name"，key 必填
//   官方插件里同样的写法见 installed dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661
//     —— key 写的就是 bundle 的包名
// key 写成 loader 的裸条目 id（cordis.patch.yml 的 `- id:`）时，宿主拿包名找不到这个
// 键，`configured` 也是 false → 插件页上永远不出卡（这个文件存在的理由）。
//
// 这两个标识**各管各的**，本模块把两边的实际来源都读出来，防止"一改就两边一起改"把另一边带错：
//   - 槽位的 key = bundle 包名，来源是本包自己的 package.json（宿主分发 entryKey 用的就是
//     被安装的那个 bundle 的包名，和装法无关）；profile 只在这台开发机上存在，装着就顺手加一道
//     "清单里确实有这一条"的本机核对；
//   - configForms.get(entryId) 的入参（= 0.1.7 隐式 settings 命名空间）= 裸条目 id，
//     来源是本包的 cordis.patch.yml（installed dsh-client-ui-settings/lib/client.js:1294-1298
//     把 entryId 原样当命名空间用）。
// 所以这里**不写任何包名或条目 id 的字面量**：在测试里复制一份常量，正是当初这个问题没被发现的原因。

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 本包的根目录：这个辅助文件和 client-freshness.ts 都放在 test/，据此定位包内文件。 */
const PKG_DIR = path.resolve(import.meta.dirname, "..");

/** 判断 unknown 是不是 Record。这里刻意自己写一份：test/ 不引入运行时依赖，
 *  实现见 shared/lib/record.ts（本包客户端那份已经删掉，别再往这里加判断）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 读一份 JSON 文件并转成 Record（形状不对就抛，不会静默换成空对象）。 */
function readJson(file: string): Record<string, unknown> {
  assert.ok(existsSync(file), `读不到 ${file}`);
  const text = readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(text);
  assert.ok(isRecord(parsed), `${file} 的顶层不是 JSON 对象`);
  return parsed;
}

/** 本包 package.json 里的 name（槽位 key 的来源；没有 name 直接抛，不许换成空串）。 */
function ownPackageName(): string {
  const own = readJson(path.join(PKG_DIR, "package.json"))["name"];
  // assert.ok 带类型谓词能收窄，assert.equal 不行：用后者就得再写一个永远走不到的三元回退，
  // 那条走不到的分支会把"根本没有 name"和"name 是空串"混成同一种失败。
  assert.ok(typeof own === "string" && own !== "", "本包 package.json 没有可用的 name");
  return own;
}

/** 本包所在的 npm scope（形如 `@scope/`）；包名没有 scope 时返回空串。 */
function ownPackageScope(name: string): string {
  const slash = name.indexOf("/");
  return name.startsWith("@") && slash > 1 ? name.slice(0, slash + 1) : "";
}

/** 去掉一个 YAML 标量的引号与行尾注释（只覆盖本文件用到的裸标量/单双引号形态）。 */
function yamlScalar(raw: string): string {
  const trimmed = raw.trim();
  const first = trimmed.slice(0, 1);
  const quote = first === '"' || first === "'" ? first : "";
  if (quote !== "") {
    const close = trimmed.indexOf(quote, 1);
    return close === -1 ? "" : trimmed.slice(1, close);
  }
  return trimmed.replace(/\s+#.*$/u, "").trim();
}

interface InsertedEntry {
  readonly id: string;
  readonly name: string;
}

/**
 * cordis.patch.yml 里 `insert:` 列表的条目（本仓的 patch 只有这一种写法：本包那一条有 id 和 name，
 * 供应卡片组件的 shared 那一条只有 name）。
 *
 * 按 YAML 缩进分段，而不是取"全文第一条 - id:"：一个文件可以有多条 insert 条目（本族其他包
 * 各自复制一份时就是这样），取第一条会把别人的 id 当成本包的，而"两个标识必须不同值"那项核对
 * 在两者恰好相等时反而会一直通过。
 */
/** 一条 `- id: …`；值可能带引号或行尾注释。 */
const ID_LINE = /^\s*-\s+id:\s*(?<value>.*)$/u;

/** 一条 `name: …`（与本包 id 在同一缩进层）。 */
const NAME_LINE = /^\s*name:\s*(?<value>.*)$/u;

function insertedEntries(yml: string): InsertedEntry[] {
  assert.match(yml, /^\s*(?:-\s+)?insert:\s*$/mu, "cordis.patch.yml 里没有 insert: 列表");
  const entries: InsertedEntry[] = [];
  let pendingId: string | undefined;
  for (const line of yml.split("\n")) {
    const id = ID_LINE.exec(line);
    const name = NAME_LINE.exec(line);
    if (id !== null) {
      pendingId = yamlScalar(id.groups?.["value"] ?? "");
    } else if (name !== null && pendingId !== undefined) {
      entries.push({ id: pendingId, name: yamlScalar(name.groups?.["value"] ?? "") });
      pendingId = undefined;
    }
  }
  if (pendingId !== undefined) {
    entries.push({ id: pendingId, name: "" });
  }
  return entries;
}

/** profile 清单文件的路径：`~/.dsh/profiles/web/package.json`（可以用 DSH_PROFILE_PACKAGE_JSON 改指到别处）。 */
function profileManifestPath(): string {
  const override = process.env["DSH_PROFILE_PACKAGE_JSON"] ?? "";
  return override === ""
    ? path.join(os.homedir(), ".dsh", "profiles", "web", "package.json")
    : override;
}

/**
 * profile 里的 `dsh.profile.bundles` 清单。
 *
 * 只有**没装 profile 的机器**（CI、使用者自己克隆）才允许返回 null：那时用的是默认路径，文件本来
 * 就不该存在。明确设置了 `DSH_PROFILE_PACKAGE_JSON` 却读不到文件是配置写错了，必须抛——不然
 * 变量指错地方，或者在 CI 里指到一个错的路径，这道本机核对就永远静默跳过，既不算失败也不算通过。
 */
function profileBundleListOrNull(): string[] | null {
  const file = profileManifestPath();
  if (!existsSync(file)) {
    assert.equal(
      process.env["DSH_PROFILE_PACKAGE_JSON"] ?? "",
      "",
      `DSH_PROFILE_PACKAGE_JSON 指向的 ${file} 不存在：显式指定了 override 就不许静默跳过这道针`,
    );
    return null;
  }
  const dshSection = readJson(file)["dsh"];
  const profileSection = isRecord(dshSection) ? dshSection["profile"] : {};
  const listed = isRecord(profileSection) ? profileSection["bundles"] : [];
  assert.ok(Array.isArray(listed), `${file} 的 dsh.profile.bundles 不是数组`);
  const items: unknown[] = listed;
  const bundles = items.filter((item): item is string => typeof item === "string");
  // 不是字符串的条目（`[{ "name": "..." }]`、数字）不能悄悄过滤掉：过滤之后本包就匹配不到
  // 自己的 scope，整道本机核对会以"没装 profile"的身份跳过，坏掉的清单照样算通过。
  assert.equal(
    bundles.length,
    items.length,
    `${file} 的 dsh.profile.bundles 里有非字符串条目：清单形状已坏，不许静默过滤`,
  );
  // 同名的 profile 未必属于这个工作区：`--from-default-profile web` 也会造出一个只装官方基础的
  // web profile。清单里一个本家族的包都没有时按"没装 profile"处理——本机核对只建立在真的装着
  // 本家族插件的 profile 上，把陌生 profile 报成"本包不在清单里"是把环境状态当成了代码漂移。
  // scope 从本包自己的包名推出来，不写 `@jayyuen66/` 字面量：这个文件是每个包一份副本，
  // 复制一份常量就意味着换了 scope 之后这道核对还在按旧 scope 判断，而它是"本家族有没有装"的唯一依据。
  const scope = ownPackageScope(ownPackageName());
  const belongsToFamily =
    scope === "" ? bundles.length > 0 : bundles.some((item) => item.startsWith(scope));
  if (!belongsToFamily) {
    return null;
  }
  return bundles;
}

/**
 * 本包在 profile 里那条 bundle 的包名 —— `plugins.bundle.config` 的 key 必须是它。
 * 取的是本包自己的 `package.json` 里的 name：宿主分发用的 `entryKey` 就是**被安装的那个 bundle**
 * 的包名，所以无论用哪种装法（registry、link、本机 profile）它都是这个值。
 * profile 只存在在这台开发机上，装着才额外加一道本机核对（清单里确实有这一条）。
 */
export function profileBundleName(): string {
  const name = ownPackageName();
  const listed = profileBundleListOrNull();
  if (listed !== null) {
    assert.ok(
      listed.includes(name),
      `${name} 不在 profile 的 dsh.profile.bundles 里：没有 bundle 行就没有配置卡`,
    );
  }
  return name;
}

/**
 * cordis.patch.yml 里的裸条目 id —— 0.1.7 的隐式 settings 命名空间与
 * `configForms.get(entryId)` 的入参都用它，和 bundle 的包名是两回事。
 *
 * 必须定位到**本 bundle 的那一条**（按 `name:` 对包名），不能取"全文第一条 `- id:`"：
 * 一个 patch 文件可以有多条 insert 条目（本族其他包各自复制一份时就是这样），取第一条会把
 * 别人的 id 当成本包的；而"两个标识必须不同值"那项核对在恰好拿到别人 id 时反而可能一直通过。
 * 引号与行尾注释由 yamlScalar 统一处理（裸写、单引号、双引号三种形态都认）。
 */
export function patchEntryId(): string {
  const yml = readFileSync(path.join(PKG_DIR, "cordis.patch.yml"), "utf8");
  const bundle = ownPackageName();
  const own = insertedEntries(yml).filter((entry) => entry.name === bundle);
  assert.equal(
    own.length,
    1,
    `cordis.patch.yml 的 insert 条目里 name 为 ${bundle} 的必须恰好一条（实得 ${String(own.length)} 条）`,
  );
  const [entry] = own;
  assert.ok(entry !== undefined, "取不到本 bundle 的 insert 条目");
  assert.notEqual(entry.id, "", `cordis.patch.yml 里 ${bundle} 那条没有裸 id`);
  return entry.id;
}

/** 取产物里 `const <name> = "<字面量>"` 的值；取不到就抛（核对不许静默放过）。 */
function constLiteral(text: string, name: string): string {
  // 标识符可能以 `$` 开头，空白和引号风格也可能随构建工具变化：先转义再匹配，
  // 否则 `$` 会被当成行尾锚点、其他元字符会变成正则注入。
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  const pattern = new RegExp(`const\\s+${escaped}\\s*=\\s*["'](?<value>[^"']*)["']`, "u");
  const value = pattern.exec(text)?.groups?.["value"] ?? "";
  assert.notEqual(value, "", `产物里找不到 const ${name} = "…" 的字面量声明`);
  return value;
}

/** 从槽位注册那一段往后取多长来找 `key:`（单位：字符）。产物里别处也有 `key:`（React 列表的 key），
 *  只能就近找；这个长度要够覆盖住整个注册对象，又不能长到跨过下一个注册对象。 */
const SLOT_KEY_WINDOW_CHARS = 500;

/** bundle 包名的形状（`@scope/name` 或裸包名）：读出来的值必须像包名，否则钉到的是别的属性。 */
const BUNDLE_NAME_SHAPE = /^(?:@[\w.-]+\/)?[\w.-]+$/u;

/** 取产物里注册 `plugins.bundle.config` 那一次用的 key（写的是字面量还是常量名都能解析出来）。 */
function registeredSlotKey(text: string): string {
  // 属性名和值之间的空白、单双引号都认：只认 `name: "…"` 这一种，压缩之后或者换了引号就整条读不到。
  const marker = /name:\s*["']plugins\.bundle\.config["']/u.exec(text);
  assert.ok(marker !== null, "产物里没有 plugins.bundle.config 的注册");
  // 只看注册位置之后的一小段：产物里别处也有 `key:`（React 列表的 key），不能全文来抓。
  const nearby = text.slice(marker.index, marker.index + SLOT_KEY_WINDOW_CHARS);
  const groups =
    /key:\s*(?:(?<quote>["'])(?<literal>[^"']*)\k<quote>|(?<ident>[A-Za-z_$][\w$]*))/u.exec(nearby)
      ?.groups ?? {};
  const literal = groups["literal"] ?? "";
  if (literal !== "") {
    assert.match(literal, BUNDLE_NAME_SHAPE, `slot 注册的 key 不像包名：${literal}`);
    return literal;
  }
  const ident = groups["ident"] ?? "";
  assert.notEqual(ident, "", "产物里读不到 slot 注册 desc 的 key（既不是字面量也不是标识符）");
  const resolved = constLiteral(text, ident);
  assert.match(resolved, BUNDLE_NAME_SHAPE, `slot 注册的 key 不像包名：${resolved}`);
  return resolved;
}

/** 取产物里每一处 `configForms.get(<入参>)` 用到的条目 id（写的是字面量还是常量名都能解析）。
 *  不要求调用点恰好一处：共享包的辅助函数被一起打包时会出现在多处，逐处比较才能既防住写错，
 *  又不因为调用点数量变化而误报失败。 */
function configFormsEntryIds(text: string): string[] {
  const matches = [...text.matchAll(/configForms\.get\(/gu)];
  assert.notEqual(matches.length, 0, "产物里没有 configForms.get(…) 调用");
  return matches.map((hit) => {
    // 匹配到的内容本身已经包含 `(`，从那里到第一个 `)` 之间就是参数（产物里这一处是简单的标识符或字面量）。
    const after = text.slice(hit.index + hit[0].length);
    const arg = (/^(?<arg>[^)]*)\)/u.exec(after)?.groups?.["arg"] ?? "").trim();
    assert.notEqual(arg, "", "产物里 configForms.get(…) 的入参读不出来");
    const inline = /^["'](?<value>[^"']*)["']$/u.exec(arg)?.groups?.["value"] ?? "";
    if (inline === "") {
      return constLiteral(text, arg);
    }
    return inline;
  });
}

/**
 * 核对两个标识有没有被写混：本次构建（buildClient()，纯函数）得到的 client 产物里
 *   1. `plugins.bundle.config` 的 key === profile `dsh.profile.bundles` 里本包那条包名；
 *   2. `configForms.get()` 的入参 === cordis.patch.yml 的裸条目 id
 *      （**不能**被顺手一起改成包名 —— 那会把客户端的写入路径再次弄坏）；
 *   3. 这两个标识取值不同（相等说明本包恰好条目 id 和包名一样，那么这一层的混用检查不出来，直接报错）。
 * 用法（在 test/build-client.test.ts 的用例里断言一次）：
 *   assert.deepEqual(await bundleSlotPinProblems(), []);
 * 这个辅助函数返回**问题清单**而不是自己注册用例：注册只能发生在用例文件的 describe 或用例体内，
 * 而且断言要写在那个体内才看得见（vitest 的 require-hook 和 expect-expect，同 client-freshness.ts）。
 * 产物结构本身读不出来的时候仍然直接抛（核对不许静默放过）。
 */
export async function bundleSlotPinProblems(): Promise<string[]> {
  // import() 只收 URL 或说明符：Windows 上裸 `C:\…` 会被当成协议 `c:` 解析而抛
  // ERR_UNSUPPORTED_ESM_URL_SCHEME，所以一律经 pathToFileURL。
  const { buildClient } = (await import(
    pathToFileURL(path.join(PKG_DIR, "build-client.mjs")).href
  )) as {
    buildClient: () => Promise<string>;
  };
  const out = await buildClient();
  const bundle = profileBundleName();
  const entryId = patchEntryId();
  const problems: string[] = [];
  if (bundle === entryId) {
    problems.push(
      "bundle 包名与裸条目 id 相同 → 这两个标识无从区分，漂移针失效，需人工确认宿主派发键",
    );
  }
  const slotKey = registeredSlotKey(out);
  if (slotKey !== bundle) {
    problems.push(
      `plugins.bundle.config 的 key 必须是 bundle 包名 ${bundle}（宿主按包名派发），写成裸条目 id ${entryId} 就是永不出卡`,
    );
  }
  const configFormsArgs = configFormsEntryIds(out);
  for (const arg of configFormsArgs) {
    if (arg !== entryId) {
      problems.push(
        `configForms.get() 的入参 ${arg} 必须仍是裸条目 id ${entryId}（0.1.7 里它就是 settings 命名空间），不得顺手换成 bundle 包名`,
      );
    }
  }
  return problems;
}
