/**
 * dsh-parallel-session —— host 侧。
 *
 * 给模型一个工具：`spawn_parallel_session`。
 * 它做的事和 `subagent` / `spawn_teammate` 不一样：
 *   - 新会话是**顶层会话**（runtime root），不是当前会话的子代理；
 *     它会照常出现在侧栏会话列表里，用户可以直接点进去聊天。
 *   - 新会话默认继承当前会话的模型、思考等级、工作区、权限；
 *     当前会话可以在调用时覆盖模型/思考等级/工作区/权限。
 *   - **权限强制收敛**：无论继承还是显式指定，都不允许把平行会话
 *     设成「完全权限」（sandbox = danger-full-access，包含 auto 预设）。
 *     父会话本身是完全权限时，平行会话降级为 workspace-write（或 read-only）。
 *   - 工具的核心参数 `context` 就是「上文交接」：当前会话把用户需要
 *     新会话知道的内容完整写进去，新会话看不到当前会话的历史。
 *
 * 实现上直接复用宿主已装配的服务：
 *   ctx.sessionController.create()   —— 走官方建会话路径（工作区、预设、持久化；标题由 sessionTitle.rename 写）
 *   agent.model.select()            —— 覆盖模型/思考等级
 *   ctx.permissionPresets.set()     —— 覆盖权限（并做完全权限收敛）
 *   agent.followup() / agent.inject() —— 交付上文（立刻开跑 / 只暂存为待发送）
 * 不 import 任何 @deepseek-ai 包，所以不依赖 profile 里是否有对应版本；
 * 所有能力都从 ctx 服务上取。
 */

import { appendFile, mkdir, realpath, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'

/** Cordis 插件名：与 package.json name 一致，client bundle 也用这个 id。 */
export const name = '@dsh-external/dsh-parallel-session'

/** 只要 tools 服务；其余宿主服务在 execute 里按需取，缺了给明确报错。 */
export const inject = ['tools']

/** 模型看到的工具名。client 卡片按这个名字注册。 */
const TOOL_NAME = 'spawn_parallel_session'

/** 完全权限判定用的沙箱模式。 */
const FULL_ACCESS_SANDBOX = 'danger-full-access'

/** 会话标题服务的部署上限是 80 字节；留一点余量。 */
const MAX_TITLE_BYTES = 72

/** 单次交接上文的上限，避免把子会话日志/首轮上下文撑爆。 */
const MAX_CONTEXT_CHARS = 100000

/** 沙箱宽窄排序：平行会话的权限不能比父会话更宽。 */
const SANDBOX_RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

/** DSH home（尊重 DSH_HOME 覆盖），调试日志落在 storages 下。 */
const DSH_HOME = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')

/** 调试日志：$DSH_HOME/storages/parallel-session/events.jsonl（重启不丢）。 */
const LOG_DIR = join(DSH_HOME, 'storages', 'parallel-session')
const LOG_FILE = join(LOG_DIR, 'events.jsonl')

/** 追加一行 JSON 调试日志；失败不影响工具本身。 */
function logEvent(entry) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
  mkdir(LOG_DIR, { recursive: true })
    .then(() => appendFile(LOG_FILE, line, 'utf8'))
    .catch(() => {})
}

/** 取一个必需的宿主服务，缺了用可读的错误信息拒绝。 */
function service(ctx, key, label) {
  const found = ctx.get(key)
  if (found === undefined || found === null) {
    throw new Error(`${label}（${key} 服务）在当前部署里不可用，无法创建平行会话。`)
  }
  return found
}

/** 按 UTF-8 字节数截断，不切坏多字节字符。 */
function truncateUtf8(text, maxBytes) {
  const input = String(text)
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let out = ''
  for (const ch of input) {
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break
    out += ch
  }
  return out.trimEnd()
}

/** 把调用者会话所属的 workspace 实体找出来（用于默认工作区与侧栏分组）。 */
function workspaceOfSession(registry, sessionId) {
  for (const workspace of registry.list()) {
    try {
      if (workspace.sessionIds.includes(sessionId)) return workspace
    } catch {
      /* 单个实体读失败就跳过 */
    }
  }
  return undefined
}

/** 权限预设的沙箱模式；未知/auto/custom 一律按「不安全」处理。 */
function sandboxOfPreset(presets, presetName) {
  try {
    return presets.resolve(presetName).sandbox
  } catch {
    return undefined
  }
}

/** 允许平行会话使用的权限预设：排除任何沙箱为完全权限的项（含 auto）。 */
function safePresetNames(presets) {
  const options = presets.catalog().options ?? []
  const names = []
  for (const option of options) {
    const presetName = option && option.value
    if (typeof presetName !== 'string') continue
    const sandbox = sandboxOfPreset(presets, presetName)
    if (sandbox !== FULL_ACCESS_SANDBOX) names.push(presetName)
  }
  return names
}

/** 判断一个预设是否会把沙箱拉到完全权限。 */
function isFullAccessPreset(presets, presetName) {
  return sandboxOfPreset(presets, presetName) === FULL_ACCESS_SANDBOX
}

/** 沙箱宽窄名次；未知模式按最宽（-1）处理，永远不通过比较。 */
function sandboxRank(mode) {
  return Object.prototype.hasOwnProperty.call(SANDBOX_RANK, mode) ? SANDBOX_RANK[mode] : -1
}

/**
 * 读一个会话「实际生效」的沙箱模式。优先用权威的 sandboxPolicy.resolve()，
 * 拿不到时退回预设表；都拿不到就返回 undefined，由调用方 fail-closed。
 */
function effectiveSandbox(ctx, session, presets, presetName) {
  const policy = ctx.get('sandboxPolicy')
  if (policy !== undefined && policy !== null && typeof policy.resolve === 'function') {
    try {
      const resolved = policy.resolve({ session })
      if (resolved !== null && resolved !== undefined && typeof resolved.mode === 'string') return resolved.mode
    } catch {
      /* 落到预设表 */
    }
  }
  if (presetName !== undefined && presetName !== 'custom') return sandboxOfPreset(presets, presetName)
  return undefined
}

/** 目标路径是否位于 root 目录内（按路径段比较，不用字符串前缀）。 */
function isWithin(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 解析新会话的位置。默认 = 父会话所属工作区；父会话不属于任何工作区时
 * 退到它当前的 working directory。显式 workspace 必须是该根目录的子目录——
 * 不允许借平行会话把写权限伸到父会话工作区之外。
 */
async function resolveLocation(ctx, parentSession, workspaceArg) {
  const registry = ctx.get('workspaceRegistry')
  const parentWorkspace = registry === undefined ? undefined : workspaceOfSession(registry, parentSession.id)
  const workingDirectory = ctx.get('workingDirectory')
  const parentDir =
    workingDirectory !== undefined ? workingDirectory.get(parentSession) : parentSession.header.cwd
  const root = parentWorkspace !== undefined ? parentWorkspace.path : parentDir
  if (root === undefined || root === null || root === '') {
    throw new Error('无法确定父会话的工作目录，拒绝创建平行会话。')
  }

  if (workspaceArg !== undefined) {
    if (typeof workspaceArg !== 'string' || workspaceArg.trim() === '') {
      throw new Error('workspace 参数必须是绝对目录路径。')
    }
    if (!isAbsolute(workspaceArg)) {
      throw new Error(`workspace 必须是绝对路径（收到 "${workspaceArg}"）。`)
    }
    let canonical
    try {
      canonical = await realpath(workspaceArg)
    } catch {
      throw new Error(`workspace 目录不存在：${workspaceArg}`)
    }
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new Error(`workspace 不是目录：${workspaceArg}`)

    let canonicalRoot
    try {
      canonicalRoot = await realpath(root)
    } catch {
      canonicalRoot = root
    }
    if (!isWithin(canonicalRoot, canonical)) {
      throw new Error(`workspace 必须位于父会话工作区「${canonicalRoot}」之内（收到 "${canonical}"）。`)
    }
    const hit = registry === undefined ? undefined : registry.list().find((workspace) => workspace.path === canonical)
    if (hit !== undefined) return { workspaceId: hit.id, cwd: hit.path, workspaceTitle: hit.title }
    return { cwd: canonical }
  }

  if (parentWorkspace !== undefined) {
    return { workspaceId: parentWorkspace.id, cwd: parentWorkspace.path, workspaceTitle: parentWorkspace.title }
  }
  return { cwd: parentDir }
}

/**
 * 解析新会话的模型/思考等级。
 * 默认与父会话当前选择完全一致；provider/model 必须成对覆盖。
 * 覆盖模型但没给思考等级时，优先沿用父会话的思考等级；新模型不支持时
 * 退回模型默认值并给出说明（而不是让创建失败）。
 */
async function resolveSelection(ctx, agent, args) {
  const llm = service(ctx, 'llm', 'LLM 路由')
  const parent = agent.model.current() ?? ctx.get('agentDefaultModel')?.currentSelection()
  if (parent === undefined || parent === null) {
    throw new Error('无法确定当前会话的模型：当前会话还没有模型选择。')
  }

  const hasProvider = args.provider !== undefined && args.provider !== null && String(args.provider).trim() !== ''
  const hasModel = args.model !== undefined && args.model !== null && String(args.model).trim() !== ''
  if (hasProvider !== hasModel) throw new Error('provider 与 model 必须同时提供，或都不提供。')

  const provider = hasProvider ? String(args.provider).trim() : parent.provider
  const model = hasModel ? String(args.model).trim() : parent.model
  const providedEffort =
    args.reasoning_effort !== undefined &&
    args.reasoning_effort !== null &&
    String(args.reasoning_effort).trim() !== ''
  const parentEffort = parent.reasoningEffort
  let effort = providedEffort ? String(args.reasoning_effort).trim() : parentEffort

  const attempt = { provider, model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) }
  try {
    await llm.resolveCallConfig(attempt)
    return { selection: attempt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const effortProblem = /reasoning effort|UNSUPPORTED_REASONING_EFFORT/i.test(message)
    if (!providedEffort && effort !== undefined && effortProblem) {
      const fallback = { provider, model }
      await llm.resolveCallConfig(fallback)
      return {
        selection: fallback,
        note: `新模型 ${provider}/${model} 不支持父会话的思考等级 "${effort}"，已改用该模型默认思考等级。`,
      }
    }
    throw new Error(`模型 ${provider}/${model}${effort !== undefined ? `（思考等级 ${effort}）` : ''} 不可用：${message}`)
  }
}

/**
 * 在创建会话之前「规划」权限。规则有三层：
 *   1. 目标预设的沙箱绝不能是完全权限（danger-full-access / auto）；
 *   2. 目标沙箱不能比父会话实际生效的沙箱更宽（read-only < workspace-write < full）；
 *   3. 父会话是完全权限时，平行会话自动降级到不宽于它的安全预设。
 * 规划阶段就拒绝非法覆盖，避免建出孤儿会话。
 */
function planPermission(ctx, parentSession, requestedPreset) {
  const presets = ctx.get('permissionPresets')
  if (presets === undefined || presets === null) {
    // fail-closed：没有权限服务就无法证明平行会话不是完全权限，宁可不建。
    throw new Error(
      '宿主没有挂载 permissionPresets 服务，无法保证平行会话不是完全权限，已拒绝创建。',
    )
  }

  const inherited = presets.current(parentSession)
  const parentSandbox = effectiveSandbox(ctx, parentSession, presets, inherited)
  if (parentSandbox === undefined) {
    throw new Error('无法确定父会话实际生效的沙箱模式，按安全规则拒绝创建平行会话。')
  }
  const parentRank = sandboxRank(parentSandbox)

  const allowed = safePresetNames(presets).filter((presetName) => sandboxRank(sandboxOfPreset(presets, presetName)) <= parentRank)
  if (allowed.length === 0) {
    throw new Error(`父会话权限是「${inherited ?? parentSandbox}」，没有不宽于它的安全预设可用，拒绝创建平行会话。`)
  }
  const fallbackName = allowed.includes('workspace-write') ? 'workspace-write' : allowed[0]

  if (requestedPreset !== undefined) {
    const wanted = String(requestedPreset)
    if (safePresetNames(presets).includes(wanted) === false) {
      throw new Error(
        `permission 只允许非完全权限预设：${safePresetNames(presets).join('、')}（收到 "${wanted}"）。完全权限不能交给平行会话。`,
      )
    }
    if (allowed.includes(wanted) === false) {
      throw new Error(
        `permission "${wanted}" 比父会话实际生效的沙箱「${parentSandbox}」更宽；平行会话的权限不能高于父会话。`,
      )
    }
  }

  let target
  let note = ''
  if (requestedPreset !== undefined) {
    target = String(requestedPreset)
  } else if (inherited === 'custom' || inherited === undefined || inherited === null) {
    target = presets.defaultPreset
  } else {
    target = inherited
  }

  if (target === 'custom' || target === undefined || target === null) target = fallbackName
  if (allowed.includes(target) === false) {
    const reason = isFullAccessPreset(presets, target)
      ? '完全权限'
      : sandboxRank(sandboxOfPreset(presets, target)) > parentRank
        ? `比父会话沙箱「${parentSandbox}」更宽`
        : '不在安全白名单内'
    note = `父会话权限是「${inherited ?? parentSandbox}」。按规则平行会话不能继承${reason}，已降级为「${fallbackName}」。`
    target = fallbackName
  }
  return { presets, target, note, parentSandbox }
}

/** 会话创建之后再真正写入权限，并用权威读法确认没有停在完全权限上。 */
function enforcePermission(ctx, plan, childSession) {
  const { presets, target, note } = plan
  if (presets.current(childSession) !== target) {
    try {
      presets.set(childSession, target)
    } catch (setError) {
      // 兜底：直接写与预设等价的三条持久事件（顺序与 set() 一致）。
      try {
        const spec = presets.resolve(target)
        childSession.append('permission/preset', { preset: target })
        childSession.append('sandbox/mode', { mode: spec.sandbox })
        childSession.append('approval/policy', { policy: spec.approval })
      } catch {
        throw setError
      }
    }
  }
  const applied = presets.current(childSession)
  if (isFullAccessPreset(presets, applied)) {
    throw new Error(`无法把平行会话权限收敛到非完全权限（当前为 "${applied}"），已中止交付。`)
  }
  const actual = effectiveSandbox(ctx, childSession, presets, applied)
  if (actual === undefined) {
    throw new Error('无法确认平行会话实际生效的沙箱模式，按安全规则中止交付。')
  }
  if (actual === FULL_ACCESS_SANDBOX) {
    throw new Error(`平行会话实际生效的沙箱是 "${actual}"（完全权限），已中止交付。`)
  }
  return { permission: applied, note }
}

/** 读会话标题：标题服务返回的是 { title, ... } 记录，不是裸字符串。 *//** 读会话标题：标题服务返回的是 { title, ... } 记录，不是裸字符串。 *//** 读会话标题：标题服务返回的是 { title, ... } 记录，不是裸字符串。 */
function readSessionTitle(titles, session) {
  if (titles === undefined || titles === null) return undefined
  try {
    const record = titles.get(session)
    if (typeof record === 'string') return record.trim() === '' ? undefined : record
    if (record !== null && typeof record === 'object' && typeof record.title === 'string') {
      return record.title.trim() === '' ? undefined : record.title
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 把任意错误压成一行消息。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 没显式给标题时，从 context 首行派生一个可读标题（避免自动标题把交接头当标题）。 */
function deriveTitleFromContext(contextText) {
  for (const rawLine of String(contextText).split(/\r?\n/)) {
    const line = rawLine
      .replace(/^[\s#>*\-–—]+/u, '')
      .replace(/`+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (line === '') continue
    return truncateUtf8(line, MAX_TITLE_BYTES) || '平行会话'
  }
  return '平行会话'
}

/** 父会话标题进交接头之前先压平：去控制字符、折叠空白、限长，避免撑坏提示结构。 */
function headerLabel(parentTitle) {
  if (typeof parentTitle !== 'string') return '另一个会话'
  const cleaned = parentTitle
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned === '') return '另一个会话'
  return cleaned.length > 60 ? `${cleaned.slice(0, 60)}…` : cleaned
}

/** 创建会话之后的失败兜底：尽力把半成品会话归档，别让它留在侧栏里。 */
async function archiveQuietly(ctx, sessionId) {
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && registry !== null && typeof registry.archiveSession === 'function') {
      await registry.archiveSession(sessionId, { stopActivity: true })
    }
  } catch {
    /* 尽力而为：归档失败不影响原始错误 */
  }
}

/** 组装交给新会话的上文。 */
function composeHandoffText({ parentTitle, context, autoStart }) {
  const label = headerLabel(parentTitle)
  const body = String(context).trim()
  const header =
    `【并行会话上文】以下内容由另一个 DSH 会话「${label}」转交，作为本会话的前置上下文。` +
    `你看不到那个会话的完整聊天记录，只有下面这段交接说明。`
  const footer = autoStart
    ? '\n\n用户随后会在这里补充具体请求。本回合请只用一两句话确认你已了解上文，并等待用户指示；不要提前开始执行任务。'
    : ''
  return `${header}\n\n${body}${footer}`
}

/** 构造一条与真实用户输入同构的持久消息。 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** 结果输出里给模型看的提示语。 */
function deliveryHint(autoStart) {
  return autoStart
    ? '平行会话已开好，上文已作为第一条用户消息送达并开始了一轮简短确认。用户点卡片上的「打开会话」即可直接继续对话。'
    : '平行会话已开好，上文已放入它的待发送输入（pending next-step）。用户打开后发送第一条消息时，上文会一并进入这一轮。'
}

/** 工具描述：模型每次请求都会看到，写清楚与 subagent 的区别和权限规则。 */
const TOOL_DESCRIPTION = [
  '开启一个与当前会话平级的新会话（parallel session），用户可以在侧栏或结果卡片里直接打开它、和它对话。',
  '和 subagent / spawn_teammate 不同：它不是当前会话的子代理，没有父会话归属，是一个真正的顶层会话；只能由顶层会话调用（子代理/团队成员会被拒绝）。',
  '新会话默认继承当前会话的模型、思考等级、工作区、权限和 agent preset；可选参数可以改模型/思考等级/工作区/权限。',
  '安全规则：不能给平行会话选择「完全权限」（danger-full-access / auto）；父会话本身是完全权限时会自动降级；平行会话的权限也永远不会比父会话更宽（父会话只读时子会话只能只读）。',
  'workspace 可选项只能指向父会话工作区内部；越界会拒绝。',
  '核心参数 context 是「上文交接」：新会话看不到当前会话的历史，必须把用户需要它知道的背景、决定、文件路径、约束完整写进 context，不要只写一句“见上文”。',
  '默认 start=true：上文作为第一条用户消息送达，新会话只做简短确认、等待用户继续；start=false 时上文只暂存为待发送输入，用户发第一条消息时一起送达。',
  '调用成功后，把结果里的 hint 转述给用户，并提醒用户点「打开会话」进入新会话。',
].join('\n')

/** 注册工具。用原始 JSON Schema，避免 import 宿主的 @deepseek-ai 包。 */
function toolDefinition(ctx) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        context: {
          type: 'string',
          description:
            '交给新会话的上文交接说明（必填）。写全：用户目标、已确认的决定、相关文件/路径、约束、下一步。新会话看不到当前会话的聊天历史。',
        },
        title: {
          type: 'string',
          description: '可选：新会话的标题（同名会写入会话标题，方便用户在侧栏认出它）。',
        },
        provider: {
          type: 'string',
          description: '可选：覆盖新会话的 LLM provider；必须与 model 同时提供。默认继承当前会话。',
        },
        model: {
          type: 'string',
          description: '可选：覆盖新会话的模型 id；必须与 provider 同时提供。默认继承当前会话。',
        },
        reasoning_effort: {
          type: 'string',
          description: '可选：覆盖思考等级（如 low / medium / high）。默认继承当前会话；改模型时若不支持会退回模型默认。',
        },
        workspace: {
          type: 'string',
          description:
            '可选：新会话的工作目录（绝对路径）。默认使用当前会话所属的工作区；若当前会话临时切换过目录，可以传当前目录。',
        },
        permission: {
          type: 'string',
          description:
            '可选：新会话权限预设。只接受非完全权限（通常 read-only / workspace-write）。默认继承当前会话，但完全权限会被强制降级。',
        },
        start: {
          type: 'boolean',
          description:
            '可选，默认 true。true：上文作为第一条用户消息立即送达并开始一轮简短确认；false：只暂存为待发送输入，等用户发第一条消息时一起送达。',
        },
      },
      required: ['context'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          workspace: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          reasoningEffort: { type: 'string' },
          permission: { type: 'string' },
          permissionNote: { type: 'string' },
          start: { type: 'boolean' },
          delivery: { type: 'string' },
          hint: { type: 'string' },
          modelNote: { type: 'string' },
          titleNote: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },

    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined || agent === null) {
        throw new Error('spawn_parallel_session 只能从某个会话里调用。')
      }
      const parentSession = agent.session
      const parentHeader = parentSession.header ?? {}

      // 只允许顶层会话使用：子代理/团队成员在后台跑，不能让它们凭空造出
      // 用户可见的会话，也避免递归开一堆平行会话。
      if (parentHeader.origin === 'subagent' || parentHeader.parentSession !== undefined) {
        throw new Error('spawn_parallel_session 只能由顶层会话调用；子代理/团队成员不能创建平行会话。')
      }

      const contextText = args.context === undefined || args.context === null ? '' : String(args.context)
      if (contextText.trim() === '') throw new Error('context 不能为空：请把需要交接给新会话的上文完整写进去。')
      if (contextText.length > MAX_CONTEXT_CHARS) {
        throw new Error(`context 太长（${contextText.length} 字符，上限 ${MAX_CONTEXT_CHARS}）。请精简交接说明。`)
      }

      // 布尔归一：模型可能把 "false" 当字符串传。
      const wantsStart = args.start !== false && args.start !== 'false' && args.start !== 0 && args.start !== '0'

      const sessionController = service(ctx, 'sessionController', '会话控制')
      const agents = service(ctx, 'agents', 'Agent 注册表')

      const location = await resolveLocation(ctx, parentSession, args.workspace)
      const { selection, note: modelNote } = await resolveSelection(ctx, agent, args)
      // 权限先规划后落盘：非法覆盖在创建会话之前就被拒绝，不会留下孤儿会话。
      const permissionPlan = planPermission(ctx, parentSession, args.permission)

      // 继承父会话的 agent preset：工具集/人格也不越权。
      let parentPreset
      if (typeof sessionController.presetForSession === 'function') {
        try {
          parentPreset = sessionController.presetForSession(parentSession)
        } catch {
          parentPreset = undefined
        }
      }

      // 先建会话（走官方路径：工作区归属、预设、持久化）。
      const baseRequest =
        location.workspaceId !== undefined ? { workspaceId: location.workspaceId } : { cwd: location.cwd }
      let created
      try {
        created = await sessionController.create(
          parentPreset === undefined ? baseRequest : { ...baseRequest, agentPreset: parentPreset },
        )
      } catch (error) {
        const code = error !== null && typeof error === 'object' ? error.code : undefined
        if (parentPreset !== undefined && (code === 'agent-preset/not-found' || code === 'agent-preset/invalid')) {
          try {
            created = await sessionController.create(baseRequest)
          } catch (retryError) {
            throw new Error(`创建平行会话失败：${messageOf(retryError)}`)
          }
        } else {
          throw new Error(`创建平行会话失败：${messageOf(error)}`)
        }
      }

      const sessionId = created.sessionId
      const child = agents.get(sessionId)
      if (child === undefined) {
        await archiveQuietly(ctx, sessionId)
        throw new Error(`平行会话 ${sessionId} 已创建但未能加载为 Agent。`)
      }

      const titles = ctx.get('sessionTitle')
      let permissionResult
      let title
      let titleNote = ''
      try {
        // 权限先落盘（必须早于 model.select 与交付）。
        permissionResult = enforcePermission(ctx, permissionPlan, child.session)

        // 模型/思考等级覆盖。
        const current = child.model.current()
        const sameSelection =
          current !== undefined &&
          current !== null &&
          current.provider === selection.provider &&
          current.model === selection.model &&
          (current.reasoningEffort ?? undefined) === (selection.reasoningEffort ?? undefined)
        if (!sameSelection) child.model.select(selection)

        // 标题：显式 title 优先；否则从 context 首行派生。
        const explicitTitle =
          args.title !== undefined && args.title !== null && String(args.title).trim() !== ''
            ? truncateUtf8(String(args.title).trim(), MAX_TITLE_BYTES)
            : undefined
        const wantedTitle = explicitTitle ?? (titles === undefined ? undefined : deriveTitleFromContext(contextText))
        if (wantedTitle !== undefined && titles !== undefined) {
          try {
            titles.rename(child.session, wantedTitle)
            title = readSessionTitle(titles, child.session)
          } catch (error) {
            titleNote = `标题写入失败（会话仍可用）：${messageOf(error)}`
          }
        }
        if (title === undefined) title = readSessionTitle(titles, child.session)

        // 交付上文：start=true 立即开一轮；start=false 只进 pending next-step。
        const parentTitle = readSessionTitle(titles, parentSession)
        const text = composeHandoffText({ parentTitle, context: contextText, autoStart: wantsStart })
        const message = userMessage(text)
        if (wantsStart) {
          if (typeof child.followup !== 'function') throw new Error('Agent 不支持 followup，无法交付上文。')
          child.followup(message)
        } else {
          if (typeof child.inject !== 'function') throw new Error('Agent 不支持 inject，无法暂存上文。')
          child.inject(message)
        }
      } catch (error) {
        const message = messageOf(error)
        // 会话已建但配置/交付失败：归档半成品，避免侧栏留下没有上文的孤儿会话。
        await archiveQuietly(ctx, sessionId)
        logEvent({ event: 'spawn-failed', parentSessionId: parentSession.id, sessionId, error: message })
        return { ok: false, sessionId, error: message }
      }

      const result = {
        ok: true,
        sessionId,
        ...(typeof title === 'string' && title !== '' ? { title } : {}),
        cwd: location.cwd,
        ...(location.workspaceTitle === undefined ? {} : { workspace: location.workspaceTitle }),
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        ...(permissionResult.permission === undefined ? {} : { permission: permissionResult.permission }),
        ...(permissionResult.note ? { permissionNote: permissionResult.note } : {}),
        start: wantsStart,
        delivery: wantsStart ? 'started' : 'queued',
        hint: deliveryHint(wantsStart),
        ...(modelNote ? { modelNote } : {}),
        ...(titleNote === '' ? {} : { titleNote }),
      }
      logEvent({
        event: 'spawn',
        parentSessionId: parentSession.id,
        sessionId,
        title: result.title,
        cwd: result.cwd,
        model: `${result.provider}/${result.model}`,
        reasoningEffort: result.reasoningEffort,
        permission: result.permission,
        start: wantsStart,
        contextChars: contextText.length,
        titleNote: titleNote || undefined,
        modelNote: result.modelNote,
        permissionNote: result.permissionNote,
      })
      return result
    },

  }
}

/** Cordis 插件入口。 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(toolDefinition(ctx)), 'parallel-session: spawn_parallel_session tool')
}
