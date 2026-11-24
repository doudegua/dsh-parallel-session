/**
 * @dsh-external/dsh-parallel-session —— client 侧。
 *
 * 只做一件事：在聊天流里给 `spawn_parallel_session` 的每次工具调用画一张小卡片，
 * 卡片右侧的「打开会话」按钮把刚从 Host 建好的那个平行会话切到主区域。
 *
 * 切会话要走 `uiWorkspace.openSession(sessionId)`：DSH 前台没有 URL router，
 * 换会话不会改地址，只能通过这个 Client 服务通知宿主。`uiWorkspace` 不是本插件
 * 的硬依赖（没装工作区 UI 时聊天也能用），所以 apply 里不声明 inject，点击时
 * 用 `ctx.get('uiWorkspace')` 现取，取不到就让按钮安静地不动。
 *
 * 本文件是手写 bundle（client-modules 注册协议 + CJS 工厂）：本机 DSH 由安装包
 * 提供运行时，没有前端工具链，所以不写 JSX、不打包，只用 react。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-parallel-session',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')

    var PLUGIN_ID = '@dsh-external/dsh-parallel-session'

    var CSS = [
      // 卡片坐在聊天流里，背景透明才不会和所在表面打架（宿主不同区域的底色并不一致）
      '.dsh-parallel-session-card{display:flex;align-items:center;gap:10px;margin:8px 0;padding:8px 12px;',
      'border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25));border-radius:10px;',
      'background:transparent;color:var(--dsw-alias-label-primary, currentColor);max-width:420px}',
      '.dsh-parallel-session-card>svg{width:18px;height:18px;flex:none;',
      'color:var(--dsw-alias-brand-primary, #4d6bfe)}',
      '.dsh-parallel-session-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.dsh-parallel-session-title{font-size:12.5px;line-height:1.4;',
      'color:var(--dsw-alias-label-primary, #1b2230);',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-parallel-session-meta{font-size:11.5px;line-height:1.4;',
      'color:var(--dsw-alias-label-tertiary, #8e97ab);',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-parallel-session-card button{font-size:12px;line-height:1;font-family:inherit;border-radius:8px;',
      'padding:6px 10px;cursor:pointer;white-space:nowrap;flex:none;',
      'color:var(--dsw-alias-label-primary-foreground, #fff);',
      'background:var(--dsw-alias-button-primary-fill, #4d6bfe);border:1px solid transparent}',
      '.dsh-parallel-session-card button:hover:not(:disabled){',
      'background:var(--dsw-alias-button-primary-hover, #5d78ff)}',
      '.dsh-parallel-session-card button:disabled{cursor:default;opacity:.6;',
      'background:var(--dsw-alias-button-primary-dimmed, rgba(77,107,254,.45))}',
      '.dsh-parallel-session-card button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary, #4d6bfe);',
      'outline-offset:1px}',

      '.dsh-parallel-session-pending{margin:8px 0;font-size:12px;line-height:1.5;',
      'color:var(--dsw-alias-label-tertiary, #8e97ab)}',

      '.dsh-parallel-session-card.is-error{',
      'border-color:var(--dsw-alias-state-error-secondary, rgba(229,72,77,.45))}',
      '.dsh-parallel-session-card.is-error>svg{color:var(--dsw-alias-state-error-primary, #e5484d)}',
      '.dsh-parallel-session-card.is-error .dsh-parallel-session-title{',
      'color:var(--dsw-alias-state-error-primary, #e5484d)}',
    ].join('')

    var EFFORT_LABELS = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高' }
    var PERMISSION_LABELS = { 'workspace-write': '工作区读写', 'read-only': '只读' }

    var ctxRef = null

    /** 两个错开的面板：平行会话就是「另一个同级的窗口」。 */
    function IconParallel() {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        React.createElement('rect', { x: 1.6, y: 2.6, width: 5.2, height: 7.2, rx: 1.4 }),
        React.createElement('rect', { x: 9.2, y: 6.2, width: 5.2, height: 7.2, rx: 1.4 }),
      )
    }

    /** 工具结果的内容块数组 → 纯文本；结果还在流式写入时可能为空。 */
    function extractResultText(props) {
      var content = props && props.block && props.block.content
      if (!content) return ''
      if (typeof content === 'string') return content
      if (!content.length) return ''
      var text = ''
      for (var i = 0; i < content.length; i++) {
        var block = content[i]
        if (block && typeof block.text === 'string') text += block.text
      }
      return text
    }

    /** 先按原样解析；个别工具会把 JSON 包在日志行里，退一步截取首尾花括号再试。 */
    function parseResultJSON(text) {
      try {
        var parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object') return parsed
      } catch (err) {
        /* 落到下面的宽松解析 */
      }
      var start = text.indexOf('{')
      var end = text.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try {
          var wrapped = JSON.parse(text.slice(start, end + 1))
          if (wrapped && typeof wrapped === 'object') return wrapped
        } catch (err2) {
          /* 不是 JSON，交给调用方按失败处理 */
        }
      }
      return null
    }

    /** 把各种形状的「原因」压成一行短文本，绝不把整个 JSON 糊到界面上。 */
    function shortReason(value) {
      var text = ''
      if (typeof value === 'string') {
        text = value
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        text = String(value)
      } else if (value && typeof value === 'object') {
        if (typeof value.message === 'string') text = value.message
        else if (typeof value.reason === 'string') text = value.reason
        else if (typeof value.code === 'string') text = value.code
      }
      text = text.replace(/\s+/g, ' ').trim()
      if (text.length > 140) text = text.slice(0, 140) + '…'
      return text
    }

    /**
     * 三种结果：
     *   null                      —— 结果还没到，显示准备态
     *   { failed: true, reason }  —— ok===false 或 JSON 解析失败
     *   { data }                  —— 成功，字段一律当作可能缺失
     */
    function readResult(props) {
      if (!props || props.phase !== 'result') return null
      var text = extractResultText(props)
      if (!text.trim()) return null
      var parsed = parseResultJSON(text)
      if (!parsed) return { failed: true, reason: shortReason(text) }
      if (parsed.ok === false) {
        var reason = shortReason(parsed.reason) || shortReason(parsed.error) || shortReason(parsed.message) || shortReason(parsed.hint)
        return { failed: true, reason: reason }
      }
      return { data: parsed }
    }

    function effortLabel(value) {
      if (!value) return ''
      var key = String(value)
      return '推理 ' + (EFFORT_LABELS[key] || key)
    }

    function permissionLabel(value) {
      if (!value) return ''
      var key = String(value)
      return PERMISSION_LABELS[key] || key
    }

    function basename(path) {
      if (typeof path !== 'string' || !path) return ''
      var parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
      return parts[parts.length - 1] || ''
    }

    /** 元信息一行：模型 · 推理等级 · 权限 · 工作区。缺什么就少一段。 */
    function metaText(data) {
      var parts = []
      var model = typeof data.model === 'string' ? data.model : ''
      var provider = typeof data.provider === 'string' ? data.provider : ''
      if (model) parts.push(model)
      else if (provider) parts.push(provider)
      var effort = effortLabel(data.reasoningEffort)
      if (effort) parts.push(effort)
      var permission = permissionLabel(data.permission)
      if (permission) parts.push(permission)
      var workspace = typeof data.workspace === 'string' && data.workspace ? data.workspace : basename(data.cwd)
      if (workspace) parts.push(workspace)
      return parts.join(' · ')
    }

    /** Host 附带的补充说明（写入失败、模型回退等）挂到悬浮提示上，不占卡片正文。 */
    function noteOf(data) {
      var notes = []
      if (typeof data.modelNote === 'string' && data.modelNote) notes.push(data.modelNote)
      if (typeof data.titleNote === 'string' && data.titleNote) notes.push(data.titleNote)
      return notes.length ? notes.join('\n') : undefined
    }

    /** 只读地拿 uiWorkspace：没装工作区 UI 时它是 undefined，不要因此报错。 */
    function getUiWorkspace() {
      if (!ctxRef) return null
      try {
        if (typeof ctxRef.get === 'function') {
          var ui = ctxRef.get('uiWorkspace')
          if (ui) return ui
        }
      } catch (err) {
        /* strict 读取失败就回到属性访问 */
      }
      try {
        if (ctxRef.uiWorkspace) return ctxRef.uiWorkspace
      } catch (err2) {
        /* 服务不可用 */
      }
      return null
    }

    /**
     * 点按钮切会话。新会话可能刚创建、客户端 summaries 还没收到：
     * uiWorkspace.openSession 会抛 unknown session，所以这里做两次短延迟重试。
     */
    function openSession(sessionId, attempt) {
      if (!sessionId) return
      var tries = typeof attempt === 'number' ? attempt : 0
      try {
        var ui = getUiWorkspace()
        if (ui && typeof ui.openSession === 'function') {
          ui.openSession(sessionId)
        }
      } catch (err) {
        if (tries < 2) {
          setTimeout(function () {
            openSession(sessionId, tries + 1)
          }, 600)
          return
        }
        console.warn('[dsh-parallel-session] open session failed', err)
      }
    }

    function PendingRow() {
      return React.createElement(
        'div',
        { className: 'dsh-parallel-session-pending' },
        '正在创建平行会话…',
      )
    }

    function FailureRow(props) {
      return React.createElement(
        'div',
        { className: 'dsh-parallel-session-card is-error' },
        React.createElement(IconParallel),
        React.createElement(
          'div',
          { className: 'dsh-parallel-session-main' },
          React.createElement('div', { className: 'dsh-parallel-session-title' }, '并行会话创建失败'),
          props.reason ? React.createElement('div', { className: 'dsh-parallel-session-meta' }, props.reason) : null,
        ),
      )
    }

    /** 工具结果卡片：spawn_parallel_session 调用在聊天里长这样。 */
    function ParallelSessionCard(props) {
      var result = readResult(props)
      if (!result) return React.createElement(PendingRow)
      if (result.failed) return React.createElement(FailureRow, { reason: result.reason })

      var data = result.data
      var sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
      var title = typeof data.title === 'string' && data.title ? data.title : '新会话'
      var titleLine = title.indexOf('平行会话') === 0 ? title : '平行会话 · ' + title
      var meta = metaText(data)
      return React.createElement(
        'div',
        { className: 'dsh-parallel-session-card' },
        React.createElement(IconParallel),
        React.createElement(
          'div',
          { className: 'dsh-parallel-session-main' },
          React.createElement(
            'div',
            {
              className: 'dsh-parallel-session-title',
              title: noteOf(data),
            },
            titleLine,
          ),
          React.createElement(
            'div',
            {
              className: 'dsh-parallel-session-meta',
              title: typeof data.permissionNote === 'string' ? data.permissionNote : undefined,
            },
            meta || '会话已创建',
          ),
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: !sessionId,
            onClick: function () {
              openSession(sessionId)
            },
          },
          '打开会话',
        ),
      )
    }

    exports.inject = ['slots']

    exports.apply = function apply(ctx) {
      ctxRef = ctx

      // 按工具名注册：聊天里每个 spawn_parallel_session 调用都长成上面那张卡片。
      ctx.effect(function () {
        return ctx.slots.inject('tool.call.toolview', function () {
          return ctx.slots.register({ name: 'tool.call.toolview', key: 'spawn_parallel_session' }, ParallelSessionCard)
        })
      }, 'dsh-parallel-session: tool card')

      if (typeof document !== 'undefined') {
        // HMR 可能在前一个实例的 effect 释放前重新 apply：先清掉同 id 的旧 style 再插。
        var stale = document.querySelectorAll('style[data-plugin="' + PLUGIN_ID + '"]')
        for (var i = 0; i < stale.length; i += 1) stale[i].remove()
        var style = document.createElement('style')
        style.dataset.plugin = PLUGIN_ID
        style.textContent = CSS
        document.head.append(style)
        ctx.effect(function () {
          return function () {
            style.remove()
          }
        }, 'dsh-parallel-session: styles')
      }
    }

    return module.exports
  },
})
