#!/bin/bash
# dsh-parallel-session 构建脚本。
#
# 本机 DSH 由安装包提供运行时，插件是零依赖纯 JavaScript：
#   - host 侧只 import node: 内置模块，宿主能力全部从 ctx 服务取；
#   - client 侧是手写 ModuleLoader bundle。
# 「构建」= 契约自检 + src → lib 同步。改完代码后让宿主重载插件即生效。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== 自检 1/5：host 入口可加载 + 工具定义契约 ==="
node --input-type=module -e '
import { pathToFileURL } from "node:url"
const mod = await import(pathToFileURL(process.argv[1]).href)
const fail = (message) => { console.error("  FAIL " + message); process.exit(1) }
if (typeof mod.apply !== "function") fail("入口必须导出 apply(ctx)")
if (typeof mod.name !== "string" || !mod.name) fail("必须导出插件 name")
if (!Array.isArray(mod.inject) || !mod.inject.includes("tools")) fail("inject 必须包含 tools")

const defs = []
const fakeCtx = {
  get: () => undefined,
  effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === "function") disposer() } },
  tools: { register: (definition) => { defs.push(definition); return () => {} } },
}
mod.apply(fakeCtx)
if (defs.length !== 1) fail("apply 必须注册恰好 1 个工具，实际 " + defs.length)
const tool = defs[0]
if (tool.name !== "spawn_parallel_session") fail("工具名不符: " + tool.name)
if (typeof tool.description !== "string" || tool.description.length < 50) fail("工具 description 过短")
if (!tool.parameters || tool.parameters.type !== "object") fail("parameters 必须是 object JSON Schema")
if (!Array.isArray(tool.parameters.required) || !tool.parameters.required.includes("context")) fail("context 必须是必填参数")
if (!tool.parameters.properties.context || tool.parameters.properties.context.type !== "string") fail("context 参数类型不符")
if (typeof tool.output.render !== "function") fail("output.render 缺失")
const rendered = tool.output.render({ context: "x" }, { ok: true, sessionId: "s" })
if (!Array.isArray(rendered) || rendered[0]?.type !== "text") fail("output.render 必须返回 text 内容块")
const parsed = JSON.parse(rendered[0].text)
if (parsed.ok !== true) fail("output.render 结果不是 JSON")
if (typeof tool.execute !== "function") fail("execute 缺失")
console.log("  ok   name=" + mod.name + " tool=" + tool.name + " inject=[" + mod.inject.join(",") + "]")
' "$ROOT/src/index.js"

echo "=== 自检 2/5：host 行为模拟（继承 / 权限收敛 / 暂存）==="
node "$ROOT/scripts/check-host.cjs"

echo "=== 自检 3/5：host 不依赖 @deepseek-ai 包（版本隔离）==="
if grep -nE "from ['\"]@deepseek-ai/" "$ROOT/src/index.js"; then
  echo "  FAIL host 侧不应 import @deepseek-ai 包" >&2
  exit 1
fi
echo "  ok   host 只使用 node: 内置模块"

echo "=== 自检 4/5：client bundle（存在时）==="
if [ -f "$ROOT/src/client/index.js" ]; then
  node "$ROOT/scripts/check-client.cjs"
else
  echo "  skip 尚未提供 src/client/index.js（host-only 阶段）"
fi

echo "=== 自检 5/5：产物同步 src → lib ==="
rm -rf lib
mkdir -p lib
cp src/index.js lib/index.js
if [ -f src/client/index.js ]; then
  cp src/client/index.js lib/client.js
fi
echo "  ok   lib/index.js $(wc -c < lib/index.js | tr -d ' ') bytes"
if [ -f lib/client.js ]; then
  echo "  ok   lib/client.js $(wc -c < lib/client.js | tr -d ' ') bytes"
fi
echo "=== Build complete ==="
