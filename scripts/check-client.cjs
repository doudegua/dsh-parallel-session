#!/usr/bin/env node
/**
 * dsh-parallel-session client bundle 契约自检。
 *
 * 宿主没有前端工具链：src/client/index.js 是手写的 ModuleLoader bundle，
 * 由 Web 客户端在浏览器里直接求值。所以这里用 node:vm 伪造浏览器全局，
 * 先证明 bundle 能被加载、注册 id 与 factory 契约正确，再把工厂真的跑一遍
 * （apply 一个假 ctx）确认它注册了 `tool.call.toolview` / `spawn_parallel_session`，
 * 最后用一个极简假 React 渲染卡片，检查成功、失败、准备三种形态与按钮行为。
 *
 * 用法：node scripts/check-client.cjs
 * 退出码 0 = CLIENT CHECK OK；非 0 = 有检查未通过（逐条打印原因）。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const CLIENT_FILE = path.join(ROOT, 'src', 'client', 'index.js')
const PLUGIN_ID = '@dsh-external/dsh-parallel-session'
const TOOL_NAME = 'spawn_parallel_session'
const SLOT_NAME = 'tool.call.toolview'

const problems = []

function check(label, ok, detail) {
  if (ok) {
    console.log('  ok   ' + label)
    return true
  }
  problems.push(label + (detail ? ' — ' + detail : ''))
  console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''))
  return false
}

function abort(message) {
  console.error('CLIENT CHECK FAILED: ' + message)
  process.exit(1)
}

/** 极简假 React：createElement 只留树，由下面的 expand/textOf/findNode 解读。 */
const fakeReact = {
  createElement: (type, props, ...kids) => ({ type, props, kids }),
}

function expand(node) {
  if (node && typeof node === 'object' && typeof node.type === 'function') {
    return expand(node.type(node.props || {}))
  }
  return node
}

/** 把元素树拍成文本，用来断言界面上出现了哪句话。 */
function textOf(node) {
  const n = expand(node)
  if (n === null || n === undefined || n === false || n === true) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.kids)
}

/** 深度优先找第一个满足条件的元素。 */
function findNode(node, predicate) {
  const n = expand(node)
  if (!n || typeof n !== 'object') return null
  if (Array.isArray(n)) {
    for (const child of n) {
      const hit = findNode(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (predicate(n)) return n
  return findNode(n.kids, predicate)
}

function main() {
  // ── 1. 在伪造的浏览器全局里求值 bundle，捕获注册对象 ──────────────────
  let source
  try {
    source = fs.readFileSync(CLIENT_FILE, 'utf8')
  } catch (err) {
    abort('读不到 ' + CLIENT_FILE + ': ' + err.message)
  }

  const styleNodes = []
  const openedWindows = []
  let registration = null

  const fakeDocument = {
    createElement(tag) {
      return {
        tagName: tag,
        dataset: {},
        textContent: '',
        removed: false,
        remove() {
          this.removed = true
        },
      }
    },
    head: {
      append(node) {
        styleNodes.push(node)
      },
    },
    querySelectorAll(selector) {
      if (typeof selector !== 'string' || selector.indexOf('style[data-plugin=') !== 0) return []
      return styleNodes.filter((node) => node.removed !== true)
    },
  }

  const fakeWindow = {
    __ModuleLoader__: {
      load(candidate) {
        registration = candidate
      },
    },
    open(url) {
      openedWindows.push(url)
    },
  }

  const context = vm.createContext({
    window: fakeWindow,
    document: fakeDocument,
    console: {
      log: (...args) => console.log(...args),
      warn: () => {},
      error: (...args) => console.error(...args),
    },
  })

  try {
    vm.runInContext(source, context, { filename: 'src/client/index.js' })
  } catch (err) {
    abort('bundle 求值抛错: ' + err.message)
  }

  if (!registration) abort('bundle 没有调用 window.__ModuleLoader__.load')
  check('调用 window.__ModuleLoader__.load', true)
  check('注册 id 为 ' + PLUGIN_ID, registration.id === PLUGIN_ID, '实际: ' + registration.id)
  if (typeof registration.factory !== 'function') abort('registration.factory 不是函数')
  check('factory 是函数', true)

  // ── 2. 执行 factory：只允许 require('react') ────────────────────────────
  const requiredSpecs = []
  let clientExports = null
  try {
    clientExports = registration.factory((spec) => {
      requiredSpecs.push(spec)
      if (spec === 'react') return fakeReact
      throw new Error('unexpected require: ' + spec)
    })
  } catch (err) {
    abort('factory 执行抛错: ' + err.message)
  }

  check('factory 只依赖 react', requiredSpecs.length === 1 && requiredSpecs[0] === 'react', '实际: ' + requiredSpecs.join(', '))
  check('导出 apply(ctx) 函数', !!clientExports && typeof clientExports.apply === 'function')
  check(
    "exports.inject 含 'slots'",
    !!clientExports && Array.isArray(clientExports.inject) && clientExports.inject.includes('slots'),
    '实际: ' + JSON.stringify(clientExports && clientExports.inject),
  )
  check(
    '源码按工具名注册 toolview',
    source.includes("name: 'tool.call.toolview'") && source.includes("key: 'spawn_parallel_session'"),
  )

  // ── 3. apply 冒烟：假 ctx 上验证 slot 注册与样式注入/回收 ──────────────
  let uiWorkspace = null
  const opened = []
  const registered = []
  const effects = []

  const fakeCtx = {
    get(name) {
      return name === 'uiWorkspace' ? uiWorkspace : undefined
    },
    slots: {
      inject(name, injectFactory) {
        const dispose = injectFactory()
        return function () {
          if (typeof dispose === 'function') dispose()
        }
      },
      register(options, component) {
        registered.push({ options, component })
        return function () {}
      },
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return function () {
        if (typeof dispose === 'function') dispose()
      }
    },
  }

  let applyThrew = false
  try {
    clientExports.apply(fakeCtx)
  } catch (err) {
    applyThrew = true
    check('apply(ctx) 不抛错', false, err.message)
  }
  if (!applyThrew) check('apply(ctx) 不抛错', true)

  const toolRegistration = registered.find((entry) => entry.options && entry.options.name === SLOT_NAME)
  check(
    'apply 注册 ' + SLOT_NAME + ' / key=' + TOOL_NAME,
    !!toolRegistration && toolRegistration.options.key === TOOL_NAME,
    '注册项: ' + JSON.stringify(registered.map((entry) => entry.options)),
  )
  check('卡片组件已挂在 slot 注册项上', !!toolRegistration && typeof toolRegistration.component === 'function')

  check(
    '注入 style[data-plugin="' + PLUGIN_ID + '"]',
    styleNodes.length === 1 && styleNodes[0].dataset.plugin === PLUGIN_ID,
    '实际样式节点: ' + styleNodes.length,
  )
  check(
    '样式类名使用 dsh-parallel-session- 前缀',
    styleNodes.length === 1 && styleNodes[0].textContent.includes('.dsh-parallel-session-'),
  )

  // effect 释放后样式必须被摘掉，否则热重载会叠加多份 CSS
  for (const dispose of effects) {
    if (typeof dispose === 'function') dispose()
  }
  check('effect 释放后移除样式', styleNodes.length === 1 && styleNodes[0].removed === true)

  if (!toolRegistration) {
    finish()
    return
  }

  // ── 4. 卡片三态 + 按钮行为 ─────────────────────────────────────────────
  const Card = toolRegistration.component
  const resultProps = (value) => ({
    phase: 'result',
    block: { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
  })

  const preparing = Card({ phase: 'preparing' })
  check('preparing 阶段显示「正在创建平行会话…」', textOf(preparing).includes('正在创建平行会话…'))
  check('preparing 阶段不渲染按钮', !findNode(preparing, (node) => node.type === 'button'))

  const starting = Card({ phase: 'start' })
  check('start 阶段同样只显示一行提示', textOf(starting).includes('正在创建平行会话…') && !findNode(starting, (node) => node.type === 'button'))

  const streaming = Card({ phase: 'result', block: { content: [] } })
  check('结果尚未流出时保持提示行', textOf(streaming).includes('正在创建平行会话…'))

  const success = {
    ok: true,
    sessionId: 'session-abc123',
    title: '方案对比',
    cwd: '/Users/example/project-demo',
    workspace: '文档工作区',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
    permission: 'workspace-write',
    start: true,
    delivery: 'started',
    hint: '已创建',
  }
  const card = Card(resultProps(success))
  const cardText = textOf(card)
  check('成功结果：标题行「平行会话 · 方案对比」', cardText.includes('平行会话 · 方案对比'))
  check(
    '成功结果：元信息含模型 / 推理 / 权限 / 工作区',
    cardText.includes('deepseek-flash') &&
      cardText.includes('推理 高') &&
      cardText.includes('工作区读写') &&
      cardText.includes('文档工作区'),
    '实际文本: ' + cardText,
  )

  const button = findNode(card, (node) => node.type === 'button')
  check(
    '成功结果：右侧「打开会话」按钮可用',
    !!button && textOf(button) === '打开会话' && button.props.disabled !== true,
    button ? '文本: ' + textOf(button) : '没有按钮',
  )

  if (button && typeof button.props.onClick === 'function') {
    uiWorkspace = {
      openSession(id) {
        opened.push(id)
      },
    }
    let clickThrew = false
    try {
      button.props.onClick()
    } catch (err) {
      clickThrew = true
      check('点击按钮不抛错', false, err.message)
    }
    if (!clickThrew) check('点击按钮不抛错', true)
    check(
      '点击按钮调用 uiWorkspace.openSession(sessionId)',
      opened.length === 1 && opened[0] === 'session-abc123',
      '实际调用: ' + JSON.stringify(opened),
    )

    // 没装工作区 UI 时按钮要安静失效，而不是把整张卡片炸掉
    uiWorkspace = null
    let missingThrew = false
    try {
      button.props.onClick()
    } catch (err) {
      missingThrew = true
    }
    check('uiWorkspace 缺失时点击不抛错', !missingThrew)
  } else {
    check('点击按钮不抛错', false, '按钮上没有 onClick')
    check('点击按钮调用 uiWorkspace.openSession(sessionId)', false, '按钮上没有 onClick')
    check('uiWorkspace 缺失时点击不抛错', false, '按钮上没有 onClick')
  }

  const prefixed = Card(resultProps({ ...success, title: '平行会话 · 方案对比' }))
  const prefixedText = textOf(prefixed)
  check(
    '标题已带「平行会话」前缀时不重复',
    prefixedText.includes('平行会话 · 方案对比') && !prefixedText.includes('平行会话 · 平行会话'),
    '实际文本: ' + prefixedText,
  )

  const noId = Card(resultProps({ ok: true, model: 'deepseek-flash' }))
  const noIdButton = findNode(noId, (node) => node.type === 'button')
  check('缺少 sessionId 时按钮禁用', !!noIdButton && noIdButton.props.disabled === true)
  check('缺少 title 时标题回退「新会话」', textOf(noId).includes('平行会话 · 新会话'))

  const failed = Card(resultProps({ ok: false, reason: '当前会话没有写权限' }))
  const failedText = textOf(failed)
  check('ok=false 显示失败行与原因', failedText.includes('并行会话创建失败') && failedText.includes('当前会话没有写权限'))
  check('失败行不渲染按钮', !findNode(failed, (node) => node.type === 'button'))

  const broken = Card(resultProps('host exploded: not json'))
  check('JSON 解析失败显示失败行且不崩溃', textOf(broken).includes('并行会话创建失败'))

  finish()
}

function finish() {
  if (problems.length) {
    console.error('\nCLIENT CHECK FAILED (' + problems.length + ')')
    for (const problem of problems) console.error('  - ' + problem)
    process.exit(1)
  }
  console.log('CLIENT CHECK OK')
}

try {
  main()
} catch (err) {
  console.error('CLIENT CHECK FAILED: 未预期异常: ' + (err && err.stack ? err.stack : err))
  process.exit(1)
}
