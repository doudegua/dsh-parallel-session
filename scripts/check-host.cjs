#!/usr/bin/env node
/**
 * dsh-parallel-session —— host 侧行为自检。
 *
 * 不起真实 DSH、不碰生产 profile：用一组最小 fake ctx 服务把
 * `spawn_parallel_session` 的 execute 跑一遍，重点覆盖安全/失败路径：
 *   1. 模型 / 思考等级 / 工作区默认继承父会话；
 *   2. 父会话是完全权限（auto / danger-full-access）时强制降级为 workspace-write；
 *   3. 平行会话的权限不能比父会话更宽（父会话只读时不能升到 workspace-write）；
 *   4. permission 覆盖只接受非完全权限，且非法值在「创建会话之前」就被拒绝；
 *   5. 宿主缺 permissionPresets 服务时 fail-closed；
 *   6. workspace 越界（父会话工作区之外）被拒绝；
 *   7. start=true 走 followup（立即开跑），start=false/"false" 走 inject（仅暂存）；
 *   8. 会话创建后配置/交付失败 → 归档半成品并返回 ok:false + sessionId；
 *   9. 子代理/团队成员不能调用；标题派生与输出契约。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..')
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parallel-session-check-'))
fs.mkdirSync(path.join(WORKSPACE_ROOT, 'sub'), { recursive: true })
const OUTSIDE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-parallel-session-outside-'))
const PARENT_SESSION_ID = 'session-parent'
const CHILD_SESSION_ID = 'session-child'

const PRESET_SPECS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  auto: { sandbox: 'danger-full-access', approval: 'ask' },
}

function makeHarness(options = {}) {
  const {
    parentCurrentPreset = 'workspace-write',
    childCurrent = 'workspace-write',
    permissionService = 'present',
    childAppendThrows = false,
  } = options
  const calls = {
    create: [],
    select: [],
    followup: [],
    inject: [],
    rename: [],
    permissionSet: [],
    archived: [],
  }
  const parentSession = { id: PARENT_SESSION_ID, header: { cwd: WORKSPACE_ROOT } }
  const parentSelection = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }
  const parentAgent = {
    session: parentSession,
    model: {
      current() {
        return { ...parentSelection }
      },
    },
  }

  const childSession = {
    id: CHILD_SESSION_ID,
    header: { cwd: WORKSPACE_ROOT },
    appended: [],
    append(type, data) {
      if (childAppendThrows) throw new Error('fake session append failed')
      this.appended.push({ type, data })
    },
  }
  const child = {
    session: childSession,
    model: {
      current() {
        return { provider: 'deepseek-official', model: 'deepseek-flash' }
      },
      select(selection) {
        calls.select.push(selection)
      },
    },
    followup(message) {
      calls.followup.push(message)
    },
    inject(message) {
      calls.inject.push(message)
    },
  }

  const presets = {
    childCurrent,
    catalog() {
      return {
        options: [
          { value: 'read-only' },
          { value: 'workspace-write' },
          { value: 'danger-full-access' },
          { value: 'auto' },
        ],
        defaultOptions: [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'danger-full-access' }],
        defaultPreset: 'workspace-write',
      }
    },
    resolve(name) {
      const spec = PRESET_SPECS[name]
      if (spec === undefined) throw new Error(`unknown preset ${name}`)
      return spec
    },
    current(session) {
      return session === parentSession ? parentCurrentPreset : this.childCurrent
    },
    set(session, name) {
      calls.permissionSet.push(name)
      assert.equal(session, childSession)
      this.childCurrent = name
      if (options.permissionSetThrows === true) throw new Error('fake permission set failed')
    },
    get defaultPreset() {
      return 'workspace-write'
    },
  }

  const sandboxPolicy = {
    resolve({ session }) {
      const preset = session === parentSession ? parentCurrentPreset : presets.childCurrent
      const spec = PRESET_SPECS[preset]
      return { mode: spec === undefined ? 'read-only' : spec.sandbox }
    },
  }

  const titles = new Map()
  const sessionTitle = {
    get(session) {
      const title = titles.get(session.id)
      return title === undefined ? undefined : { title, source: { kind: 'user' } }
    },
    rename(session, title) {
      calls.rename.push(title)
      titles.set(session.id, title)
      return { title, eventSeq: 1 }
    },
  }

  const services = {
    sessionController: {
      async create(request) {
        calls.create.push(request)
        return { sessionId: CHILD_SESSION_ID }
      },
      presetForSession() {
        return undefined
      },
    },
    agents: {
      get(id) {
        assert.equal(id, CHILD_SESSION_ID)
        return child
      },
    },
    llm: {
      async resolveCallConfig(config) {
        assert.equal(typeof config.provider, 'string')
        assert.equal(typeof config.model, 'string')
        return config
      },
    },
    permissionPresets: permissionService === 'present' ? presets : undefined,
    sandboxPolicy,
    workspaceRegistry: {
      list() {
        return [{ id: 'ws-1', path: WORKSPACE_ROOT, title: 'Workspace', sessionIds: [PARENT_SESSION_ID] }]
      },
      async archiveSession(sessionId) {
        calls.archived.push(sessionId)
      },
    },
    workingDirectory: {
      get() {
        return WORKSPACE_ROOT
      },
    },
    sessionTitle,
  }

  const defs = []
  const ctx = {
    get(name) {
      return services[name]
    },
    effect(fn) {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    tools: {
      register(definition) {
        defs.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, defs, calls, parentAgent, parentSession, presets, titles, childSession }
}

async function loadTool() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/index.js')).href)
  assert.equal(typeof mod.apply, 'function')
  return mod
}

function install(mod, harness) {
  mod.apply(harness.ctx)
  assert.equal(harness.defs.length, 1, 'apply 必须注册恰好 1 个工具')
  return harness.defs[0]
}

async function expectReject(promiseFactory, pattern) {
  await assert.rejects(promiseFactory, (error) => {
    assert.match(error.message, pattern)
    return true
  })
}

async function main() {
  const mod = await loadTool()

  // --- 1. 默认继承 + 父会话完全权限（auto）→ 降级 workspace-write，start 默认 true ---
  {
    const h = makeHarness({ parentCurrentPreset: 'auto', childCurrent: 'read-only' })
    const tool = install(mod, h)
    const result = await tool.execute(
      { context: '用户正在做插件开发，路径 /tmp/x，接下来继续写文档。', title: '继承测试' },
      { agent: h.parentAgent },
    )
    assert.deepEqual(h.calls.create[0], { workspaceId: 'ws-1' }, '默认应使用父会话所属工作区')
    assert.deepEqual(h.calls.select[0], { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
    assert.deepEqual(h.calls.permissionSet, ['workspace-write'], '完全权限必须降级')
    assert.match(result.permissionNote, /降级/)
    assert.equal(result.permission, 'workspace-write')
    assert.equal(result.workspace, 'Workspace')
    assert.equal(result.start, true)
    assert.equal(h.calls.followup.length, 1)
    const text = h.calls.followup[0].content[0].text
    assert.match(text, /并行会话上文/)
    assert.match(text, /用户正在做插件开发/)
    assert.match(text, /本回合请只用一两句话确认/)
    console.log('  ok   默认继承 + auto 权限降级 + 立即开跑 + 标题写入')
  }

  // --- 2. 显式覆盖：read-only + low + start=false（暂存） ---
  {
    const h = makeHarness({ parentCurrentPreset: 'workspace-write' })
    const tool = install(mod, h)
    const result = await tool.execute(
      { context: '暂存的上文', permission: 'read-only', reasoning_effort: 'low', start: false },
      { agent: h.parentAgent },
    )
    assert.deepEqual(h.calls.select[0], { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' })
    assert.equal(result.permission, 'read-only')
    assert.equal(result.start, false)
    assert.equal(h.calls.inject.length, 1)
    assert.equal(h.calls.followup.length, 0)
    assert.doesNotMatch(h.calls.inject[0].content[0].text, /本回合请只用一两句话确认/)
    console.log('  ok   显式覆盖权限/思考等级 + start=false 只暂存不开跑')
  }

  // --- 3. 完全权限覆盖在创建会话之前被拒绝 ---
  for (const forbidden of ['danger-full-access', 'auto']) {
    const h = makeHarness()
    const tool = install(mod, h)
    await expectReject(() => tool.execute({ context: 'x', permission: forbidden }, { agent: h.parentAgent }), /只允许非完全权限/)
    assert.equal(h.calls.create.length, 0, `${forbidden}：拒绝必须发生在创建会话之前`)
    console.log(`  ok   permission=${forbidden} 在创建会话之前被拒绝（无孤儿会话）`)
  }

  // --- 4. 权限不能比父会话更宽：父只读 → 不能请求 workspace-write ---
  {
    const h = makeHarness({ parentCurrentPreset: 'read-only' })
    const tool = install(mod, h)
    await expectReject(
      () => tool.execute({ context: '越权', permission: 'workspace-write' }, { agent: h.parentAgent }),
      /不能高于父会话|更宽/,
    )
    assert.equal(h.calls.create.length, 0)
    console.log('  ok   父会话只读时不能把平行会话提升到 workspace-write')
  }

  // --- 5. 缺 permissionPresets 服务时 fail-closed ---
  {
    const h = makeHarness({ permissionService: 'missing' })
    const tool = install(mod, h)
    await expectReject(
      () => tool.execute({ context: '没有任何权限服务' }, { agent: h.parentAgent }),
      /permissionPresets/,
    )
    assert.equal(h.calls.create.length, 0)
    console.log('  ok   宿主缺 permissionPresets 时 fail-closed（不创建会话）')
  }

  // --- 6. workspace 越界被拒绝 ---
  {
    const h = makeHarness()
    const tool = install(mod, h)
    await expectReject(
      () => tool.execute({ context: '越界目录', workspace: OUTSIDE_ROOT }, { agent: h.parentAgent }),
      /必须位于父会话工作区/,
    )
    assert.equal(h.calls.create.length, 0)
    const inside = makeHarness()
    const insideTool = install(mod, inside)
    const result = await insideTool.execute(
      { context: '工作区子目录', workspace: path.join(WORKSPACE_ROOT, 'sub'), start: false },
      { agent: inside.parentAgent },
    )
    assert.equal(result.ok, true)
    assert.equal(result.cwd, fs.realpathSync(path.join(WORKSPACE_ROOT, 'sub')))
    console.log('  ok   workspace 只允许父会话工作区之内（越界拒绝、子目录放行）')
  }

  // --- 7. start:"false" 字符串按 false 处理 ---
  {
    const h = makeHarness()
    const tool = install(mod, h)
    const result = await tool.execute({ context: '字符串 false', start: 'false' }, { agent: h.parentAgent })
    assert.equal(result.start, false)
    assert.equal(h.calls.inject.length, 1)
    assert.equal(h.calls.followup.length, 0)
    console.log('  ok   start:"false" 字符串按 false 处理')
  }

  // --- 8. 创建后配置失败 → 归档半成品并返回 ok:false + sessionId ---
  {
    const h = makeHarness({ permissionSetThrows: true, childAppendThrows: true, childCurrent: 'read-only' })
    const tool = install(mod, h)
    const result = await tool.execute({ context: '写入权限会失败的场景' }, { agent: h.parentAgent })
    assert.equal(result.ok, false)
    assert.equal(result.sessionId, CHILD_SESSION_ID)
    assert.match(result.error, /permission set failed/)
    assert.deepEqual(h.calls.archived, [CHILD_SESSION_ID], '半成品会话必须被归档')
    assert.equal(h.calls.followup.length, 0, '权限失败时不能交付上文')
    console.log('  ok   创建后失败 → 归档半成品 + 返回 ok:false + sessionId')
  }

  // --- 9. 子代理/团队成员不能调用 ---
  {
    const h = makeHarness()
    const tool = install(mod, h)
    const subagentAgent = {
      session: { id: 'session-child-of-parent', header: { origin: 'subagent', parentSession: PARENT_SESSION_ID } },
      model: { current: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
    }
    await expectReject(() => tool.execute({ context: '子代理不能开' }, { agent: subagentAgent }), /只能由顶层会话调用/)
    assert.equal(h.calls.create.length, 0)
    console.log('  ok   子代理/团队成员调用被拒绝')
  }

  // --- 10. 覆盖模型但不覆盖思考等级：沿用父会话思考等级 ---
  {
    const h = makeHarness({ parentCurrentPreset: 'workspace-write' })
    const tool = install(mod, h)
    const result = await tool.execute(
      { context: '换模型测试', provider: 'deepseek-official', model: 'deepseek-pro', start: false },
      { agent: h.parentAgent },
    )
    assert.deepEqual(h.calls.select[0], { provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' })
    assert.equal(result.reasoningEffort, 'high')
    console.log('  ok   覆盖模型时仍沿用父会话思考等级')
  }

  // --- 11. 无 title 时从 context 首行派生标题 ---
  {
    const h = makeHarness()
    const tool = install(mod, h)
    const result = await tool.execute(
      { context: '## 重构支付模块\n\n先读 README，再拆出 service。', start: false },
      { agent: h.parentAgent },
    )
    assert.equal(result.title, '重构支付模块')
    assert.equal(h.calls.rename.includes('重构支付模块'), true)
    console.log('  ok   无 title 时从 context 首行派生标题')
  }

  // --- 12. 输出 schema 与 render 契约 ---
  {
    const h = makeHarness()
    const tool = install(mod, h)
    assert.equal(tool.parameters.required.includes('context'), true)
    assert.equal(tool.parameters.additionalProperties, false)
    const blocks = tool.output.render({}, { ok: true, sessionId: 's', permission: 'read-only' })
    assert.equal(blocks[0].type, 'text')
    assert.equal(JSON.parse(blocks[0].text).sessionId, 's')
    console.log('  ok   参数/输出 schema 与 render 契约')
  }

  console.log('HOST CHECK OK')
}

main()
  .catch((error) => {
    console.error('HOST CHECK FAILED')
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true })
    fs.rmSync(OUTSIDE_ROOT, { recursive: true, force: true })
  })
