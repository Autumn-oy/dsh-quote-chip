// dsh-quote-chip — browser half.
//
// 选中对话正文 → 浮条「引用」把选中内容作为**不可编辑的引用芯片**插入输入框
// （编辑器原生 reference chip：只能整枚删除，不能改字），发送时由本插件注册的
// 引用源 codec 还原成 Markdown 引用块；浮条「向子代理提问」把引用 + 问题组成
// 消息交给当前会话的 subagent 工具去问。
//
// WHY A RESIDENT PLUGIN: 动态 Cordis Package 被 Client Guard 禁止拿别人的
// context（"service sessions returned a cordis Context, which the dynamic facade
// does not expose"），因此无法派发 `slash/input-insert-reference` 作用域事件，
// 也就插不出原生芯片。常驻插件没有这个限制。
//
// DEGRADATION: 每个环节都做存在性判断。注册不到 inputTriggers（芯片没有 codec
// 归属，发送时会被卡住）时，自动退回"纯文本引用"，绝不插入一枚发不出去的芯片。

window.__ModuleLoader__.load({
  id: 'dsh-quote-chip',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var SOURCE = 'quote'
    var DEFAULT_QUESTION = '请解释这段内容的含义、背景和要点。'

    var CSS = [
      '@keyframes dsq-in{from{opacity:0}to{opacity:1}}',
      '.dsq-layer{position:fixed;inset:0;pointer-events:none;z-index:70}',
      '.dsq-pop{position:fixed;display:flex;align-items:center;gap:2px;padding:4px;border-radius:12px;background:var(--dsw-alias-bg-overlay,#1c1d21);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));box-shadow:0 10px 30px rgba(0,0,0,.28),0 1px 2px rgba(0,0,0,.16);pointer-events:auto;font-size:12.5px;line-height:1;white-space:nowrap;color:var(--dsw-alias-label-primary,#eee);animation:dsq-in .12s ease-out}',
      '.dsq-pop button{font:inherit;line-height:1;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;transition:background .12s ease,opacity .12s ease}',
      '.dsq-pop button:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16))}',
      '.dsq-pop button:active{opacity:.7}',
      '.dsq-pop .dsq-accent{color:var(--dsw-alias-brand-primary,#3b6ef0);background:transparent;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6ef0) 14%,transparent)}',
      '.dsq-pop .dsq-accent:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6ef0) 26%,transparent)}',
      '.dsq-pop .dsq-icon{width:28px;padding:0;font-size:13px}',
      '.dsq-input{font:inherit;height:28px;width:210px;padding:0 9px;margin-right:2px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));color:inherit;outline:none}',
      '.dsq-input:focus{border-color:var(--dsw-alias-brand-primary,#3b6ef0);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6ef0) 55%,transparent)}',
      '.dsq-note{color:var(--dsw-alias-state-error-primary,#e5484d);padding:0 8px}',
      '.dsq-pill{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);cursor:pointer;font:inherit;font-size:12.5px;line-height:1;white-space:nowrap;transition:background .12s ease,color .12s ease}',
      '.dsq-pill:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,#eee)}',
      '.dsq-pill:active{opacity:.7}',
      '.dsq-pill-note{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;padding:0 4px}',
      '.dsq-pillwrap{display:inline-flex;align-items:center;gap:2px}',
    ].join('\n')

    var selectDraft = function (state) { return state.draft }
    var selectRev = function (state) { return state.draftRev }
    var selectPhase = function (state) { return state.phase }
    // 会话快照的 subagent：普通会话为 null，子代理会话为 { address, parentAvailable? }。
    // 注意这个字段只在会话控制器配置过 address 时才有值（例如经子代理目录打开），
    // 直接切进子会话可能仍是 null，所以还要用下面的 SessionSummary.origin 兜底。
    var selectIsSubagent = function (snapshot) {
      return snapshot.subagent !== undefined && snapshot.subagent !== null
    }
    // 会话列表里的持久标记：子代理会话的 summary 带 origin === 'subagent'。
    var selectSummaryById = function (store) {
      return store.byId
    }

    function installStyles() {
      try {
        if (document.getElementById('dsh-quote-chip-styles') !== null) return
        var tag = document.createElement('style')
        tag.id = 'dsh-quote-chip-styles'
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch (error) {
        console.error('[dsh-quote-chip] 样式注入失败:', error)
      }
    }

    // 引用在消息里的形态：【引用】 + 每行 > 的引用块 + 【引用结束】。
    // 历史里仍是标准 Markdown 引用块，前后又有一对显式边界，模型不会把引用当成用户自己的话。
    function quoteBlock(text) {
      var lines = String(text).split(/\r?\n/)
      var out = ['【引用】']
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i].replace(/\s+$/, '')
        out.push(line.trim().length === 0 ? '>' : '> ' + line)
      }
      out.push('【引用结束】')
      return out.join('\n')
    }

    function previewOf(text) {
      var flat = String(text).replace(/\s+/g, ' ').trim()
      return flat.length > 24 ? flat.slice(0, 24) + '…' : flat
    }

    function apply(ctx) {
      installStyles()
      if (typeof ctx.inject !== 'function') {
        console.error('[dsh-quote-chip] ctx.inject 不可用，工具条未注册')
        return
      }
      var react = null
      try {
        react = require('react')
      } catch (error) {
        console.error('[dsh-quote-chip] 无法 require("react")，工具条未注册:', error)
      }
      if (react === null) return

      var own = function (register) {
        try {
          if (typeof ctx.effect === 'function') return ctx.effect(register)
        } catch (error) {
          console.error('[dsh-quote-chip] ctx.effect 不可用，直接注册:', error)
        }
        try {
          return register()
        } catch (error) {
          console.error('[dsh-quote-chip] 注册失败:', error)
          return undefined
        }
      }

      var bridge = { sink: null, isSubagentSession: false }
      var sourceRegistered = false
      var sessionsService = null

      // 1) 引用源：芯片的模型文本由它的 codec 负责。注册不到就永不使用芯片路径。
      ctx.inject(['inputTriggers'], function (scope) {
        try {
          var triggers = scope.inputTriggers
          if (triggers === undefined || triggers === null || typeof triggers.registerSource !== 'function') {
            console.error('[dsh-quote-chip] inputTriggers 不可用，引用将以纯文本插入')
            return
          }
          own(function () {
            return triggers.registerSource({
              trigger: '@',
              name: SOURCE,
              showGroupTitle: false,
              candidates: function () { return Promise.resolve([]) },
              onPick: function () { return undefined },
              codec: {
                clipboardText: function (ref) { return ref },
                serialize: function (ref) { return Promise.resolve(ref) },
              },
            })
          })
          sourceRegistered = true
        } catch (error) {
          console.error('[dsh-quote-chip] registerSource 失败，引用将以纯文本插入:', error)
        }
      })

      // 2) 会话作用域：只有它能把"插入一枚芯片"交给输入框自己执行。
      ctx.inject(['sessions'], function (scope) { sessionsService = scope.sessions })

      var sessionsOf = function () {
        if (sessionsService !== null && sessionsService !== undefined) return sessionsService
        try {
          return ctx.get('sessions')
        } catch (error) {
          return undefined
        }
      }

      var insertChip = function (text, sessionId, draftRev, phase) {
        if (sourceRegistered !== true) return false
        if (phase !== 'plain') return false
        var service = sessionsOf()
        if (service === undefined || service === null || typeof service.scope !== 'function') return false
        var actx
        try {
          actx = service.scope(sessionId)
        } catch (error) {
          console.error('[dsh-quote-chip] 取会话作用域失败:', error)
          return false
        }
        if (actx === undefined || actx === null || typeof actx.bail !== 'function') return false
        // 结尾留一个空行：用户接着写的问题不会被吞进引用块里。
        var payload = quoteBlock(text) + '\n\n'
        try {
          var applied = actx.bail(actx, 'slash/input-insert-reference', {
            reference: {
              source: SOURCE,
              ref: payload,
              label: '引用：' + previewOf(text),
              appearance: 'session',
              clipboardText: payload,
            },
            span: { start: 0, end: 0, draftRev: draftRev },
          })
          return applied === true
        } catch (error) {
          console.error('[dsh-quote-chip] 插入引用芯片失败:', error)
          return false
        }
      }

      // 3) 会话域桥：草稿、inputActions 与芯片插入都只在这里可见。
      function Bridge(props) {
        var inputActions = props.inputActions
        var sessionId = props.sessionId
        var draft = props.useInput(selectDraft)
        var rev = props.useInput(selectRev)
        var phase = props.useInput(selectPhase)
        // 子代理会话里不再提供「向子代理提问」：不允许孙代理层层套下去。
        // 两个来源任一命中即算子会话：快照的 subagent，或列表 summary 的 origin。
        var summaryById = props.useSessions(selectSummaryById)
        var row = summaryById === undefined || summaryById === null ? undefined : summaryById[sessionId]
        var inSubagentSession = props.useSession(selectIsSubagent) === true ||
          (row !== undefined && row !== null && row.origin === 'subagent')
        bridge.isSubagentSession = inSubagentSession
        var live = react.useRef({ draft: '', rev: 0, phase: 'plain' })
        live.current.draft = draft
        live.current.rev = rev
        live.current.phase = phase
        var pendingPair = react.useState(null)
        var pending = pendingPair[0]
        var setPending = pendingPair[1]

        react.useEffect(function () {
          if (inputActions === undefined || inputActions === null) return undefined
          var write = function (text) {
            try {
              inputActions.setDraft(text)
              return true
            } catch (error) {
              console.error('[dsh-quote-chip] setDraft 失败:', error)
              return false
            }
          }
          var join = function (block) {
            var current = live.current.draft === undefined || live.current.draft === null ? '' : String(live.current.draft)
            if (current.trim().length === 0) return block + '\n'
            return current.replace(/\s+$/, '') + '\n\n' + block + '\n'
          }
          var sink = {
            quote: function (text) {
              if (insertChip(text, sessionId, live.current.rev, live.current.phase)) return 'chip'
              return write(join(quoteBlock(text))) ? 'text' : false
            },
            ask: function (question, text) {
              // 只保留一种提问语义：后台发起的可续聊子代理。
              // 输入框里有内容时绝不覆盖 —— 那是用户正在打的东西。
              var current = live.current.draft === undefined || live.current.draft === null ? '' : String(live.current.draft)
              if (current.trim().length > 0) return 'busy'
              var body = '请用 subagent 在后台发起一个**可续聊**子代理（run_in_background: true，不要等它返回；不要用前台一次性模式），'
                + '把下面这段引用和我的问题交给它。发起后不用管它，我会直接开它的会话继续追问，你只需要知道有这么一件事。\n'
                + '交给它的任务里请附一句：不要再用 send_message 额外推一份给主代理，结论写在收尾消息里即可。\n\n'
                + '**我的问题**：' + question + '\n\n'
                + quoteBlock(text) + '\n'
              if (write(body) === false) return false
              setPending(body)
              return true
            },
          }
          bridge.sink = sink
          return function () {
            if (bridge.sink === sink) bridge.sink = null
            if (bridge.isSubagentSession === inSubagentSession) bridge.isSubagentSession = false
          }
        }, [inputActions, sessionId, inSubagentSession])

        // 确定性交接：等输入机器真的装上了这段草稿再提交，避免把旧草稿发出去。
        react.useEffect(function () {
          if (pending === null || draft !== pending) return
          setPending(null)
          try {
            inputActions.submit()
          } catch (error) {
            console.error('[dsh-quote-chip] submit 失败:', error)
          }
        }, [draft, pending, inputActions])

        return null
      }

      // 4) 浮层工具条：与输入框无关，挂在框架级浮层上。
      function Toolbar() {
        var rootRef = react.useRef(null)
        var selPair = react.useState(null)
        var sel = selPair[0]
        var setSel = selPair[1]
        var modePair = react.useState('idle')
        var mode = modePair[0]
        var setMode = modePair[1]
        var questionPair = react.useState(DEFAULT_QUESTION)
        var question = questionPair[0]
        var setQuestion = questionPair[1]
        var notePair = react.useState('')
        var note = notePair[0]
        var setNote = notePair[1]
        var state = react.useRef({ mode: 'idle', sel: null, question: DEFAULT_QUESTION, skip: '' })
        state.current.mode = mode
        state.current.sel = sel
        state.current.question = question

        react.useEffect(function () {
          var node = rootRef.current
          if (node === null || node === undefined) return undefined
          var doc = node.ownerDocument || document
          var win = doc.defaultView

          // 任何可编辑区域（Lexical 输入框、它的芯片节点、普通 input）都不触发。
          var blockedHost = function (start) {
            var el = start
            if (el === null || el === undefined) return false
            if (el.nodeType !== 1) el = el.parentElement
            while (el !== null && el !== undefined) {
              if (el.isContentEditable === true) return true
              var tag = el.tagName === undefined || el.tagName === null ? '' : String(el.tagName).toUpperCase()
              if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
              if (typeof el.getAttribute === 'function') {
                if (el.getAttribute('contenteditable') !== null) return true
                if (el.getAttribute('role') === 'textbox') return true
                if (el.getAttribute('data-dsq-pop') === '1') return true
              }
              el = el.parentElement
            }
            return false
          }

          var read = function () {
            if (state.current.mode === 'ask') return
            var selection = doc.getSelection()
            if (selection === null || selection === undefined || selection.isCollapsed === true || selection.rangeCount === 0) {
              state.current.skip = ''
              setSel(null)
              return
            }
            var text = String(selection.toString()).trim()
            if (text.length < 2) {
              state.current.skip = ''
              setSel(null)
              return
            }
            if (blockedHost(selection.anchorNode) || blockedHost(selection.focusNode)) {
              state.current.skip = ''
              setSel(null)
              return
            }
            if (state.current.skip === text) return
            var rect
            try {
              rect = selection.getRangeAt(0).getBoundingClientRect()
            } catch (error) {
              return
            }
            if (rect === undefined || rect === null) return
            if (rect.width === 0 && rect.height === 0) return
            var width = win && win.innerWidth ? win.innerWidth : 1024
            var half = 200
            var x = rect.left + rect.width / 2
            if (x < half + 8) x = half + 8
            if (x > width - half - 8) x = width - half - 8
            var above = rect.top > 64
            setNote('')
            setSel({ text: text.slice(0, 4000), x: x, y: above ? rect.top - 8 : rect.bottom + 8, above: above })
          }

          var onKey = function (event) {
            if (event.key !== 'Escape') return
            var current = state.current.sel
            if (current === null) return
            state.current.skip = current.text
            setSel(null)
            setMode('idle')
          }

          doc.addEventListener('selectionchange', read)
          doc.addEventListener('mouseup', read, true)
          doc.addEventListener('scroll', read, true)
          doc.addEventListener('keydown', onKey)
          return function () {
            doc.removeEventListener('selectionchange', read)
            doc.removeEventListener('mouseup', read, true)
            doc.removeEventListener('scroll', read, true)
            doc.removeEventListener('keydown', onKey)
          }
        }, [])

        var applyQuote = function () {
          var current = state.current.sel
          if (current === null) return
          var sink = bridge.sink
          if (sink === null || sink === undefined) {
            setNote('当前会话没有可用的输入框')
            return
          }
          state.current.skip = current.text
          if (sink.quote(current.text) === false) {
            setNote('写入输入框失败')
            return
          }
          setSel(null)
          setMode('idle')
        }

        var applyAsk = function () {
          var current = state.current.sel
          if (current === null) return
          var sink = bridge.sink
          if (sink === null || sink === undefined) {
            setNote('当前会话没有可用的输入框')
            return
          }
          var asked = state.current.question.trim().length > 0 ? state.current.question.trim() : DEFAULT_QUESTION
          state.current.skip = current.text
          var result = sink.ask(asked, current.text)
          if (result === 'busy') {
            setNote('输入框里已有内容，先清空它')
            return
          }
          if (result === false) {
            setNote('写入输入框失败')
            return
          }
          setSel(null)
          setMode('idle')
        }

        var children = []
        if (sel !== null) {
          if (mode === 'ask') {
            children.push(react.createElement('input', {
              className: 'dsq-input',
              key: 'q',
              value: question,
              autoFocus: true,
              placeholder: '要问子代理什么？',
              onChange: function (event) { setQuestion(event.target.value) },
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  applyAsk()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setMode('idle')
                }
              },
            }))
            children.push(react.createElement('button', {
              className: 'dsq-accent',
              key: 's',
              title: '后台发起可续聊子代理：你直接开它的会话继续追问，主代理只收到一条结束通知',
              onClick: applyAsk,
            }, '发送'))
            children.push(react.createElement('button', {
              className: 'dsq-icon',
              key: 'c',
              title: '取消',
              onClick: function () { setMode('idle') },
            }, '✕'))
          } else {
            children.push(react.createElement('button', {
              key: 'a',
              title: '把选中内容作为不可编辑的引用插入输入框',
              onClick: applyQuote,
            }, '引用'))
            if (bridge.isSubagentSession === true) {
              // 子代理会话：只留「引用」——不允许再套孙代理。
            } else {
              children.push(react.createElement('button', {
                className: 'dsq-accent',
                key: 'b',
                title: '就选中内容向子代理提问',
                onClick: function () {
                  setNote('')
                  setMode('ask')
                },
              }, '向子代理提问'))
            }
          }
          if (note.length > 0) children.push(react.createElement('span', { className: 'dsq-note', key: 'n' }, note))
        }

        var pop = sel === null ? null : react.createElement('div', {
          className: 'dsq-pop',
          'data-dsq-pop': '1',
          style: {
            left: sel.x + 'px',
            top: sel.y + 'px',
            transform: sel.above ? 'translate(-50%, -100%)' : 'translateX(-50%)',
          },
          onMouseDown: function (event) {
            var target = event.target
            var tag = target && target.tagName ? String(target.tagName).toLowerCase() : ''
            if (tag === 'input' || tag === 'textarea') return
            event.preventDefault()
          },
        }, children)

        return react.createElement('div', { className: 'dsq-layer', ref: rootRef }, pop)
      }

      // 4b) 子代理会话输入框右侧的按钮：请求主代理介入（读这个子代理的完整记录）。
      //     它只发一条极短信号（让这一轮尽快结束），全量内容由主代理自己读会话日志。
      function RecapButton(props) {
        var inputActions = props.inputActions
        var sessionId = props.sessionId
        var draft = props.useInput(selectDraft)
        var summaryById = props.useSessions(selectSummaryById)
        var row = summaryById === undefined || summaryById === null ? undefined : summaryById[sessionId]
        var inSubagentSession = props.useSession(selectIsSubagent) === true ||
          (row !== undefined && row !== null && row.origin === 'subagent')
        var notePair = react.useState('')
        var note = notePair[0]
        var setNote = notePair[1]
        var live = react.useRef({ draft: '' })
        live.current.draft = draft
        var pendingPair = react.useState(null)
        var pending = pendingPair[0]
        var setPending = pendingPair[1]

        // 确定性交接：等输入机器真的装上了这条回流信号再提交。
        react.useEffect(function () {
          if (pending === null || draft !== pending) return
          setPending(null)
          if (inputActions === undefined || inputActions === null) return
          try {
            inputActions.submit()
          } catch (error) {
            console.error('[dsh-quote-chip] 回流信号提交失败:', error)
          }
        }, [draft, pending, inputActions])

        if (inSubagentSession !== true) return null
        if (inputActions === undefined || inputActions === null) return null

        var click = function () {
          var current = live.current.draft === undefined || live.current.draft === null ? '' : String(live.current.draft)
          if (current.trim().length > 0) {
            setNote('输入框里已有内容，先清空它')
            return
          }
          setNote('')
          // 让它自己写一份给主代理的简报：它知道对话里发生了什么，
          // 写出来的比我粗暴抽日志更准，而且主代理这边只多一段文本、不用多跑调用。
          var body = '【主代理介入】请把这次对话整理成一份给主代理的简报：结论、关键依据、以及你不确定或未验证的地方。'
            + '篇幅你自己判断，宁可具体也不要空泛 —— 这份简报会作为你的收尾消息回流给主代理。\n'
          try {
            inputActions.setDraft(body)
          } catch (error) {
            console.error('[dsh-quote-chip] 回流信号写入失败:', error)
            setNote('写入输入框失败')
            return
          }
          setPending(body)
        }

        var button = react.createElement('button', {
          key: 'r',
          className: 'dsq-pill',
          title: '让它把这次对话整理成一份给主代理的简报（结论/依据/不确定处），随它的收尾消息回流。主代理需要原文核实时会另外读日志。',
          onClick: click,
        }, [
          react.createElement('span', { className: 'dsq-dot', key: 'd' }),
          react.createElement('span', { key: 't' }, '主代理介入'),
        ])
        if (note.length === 0) return button
        return react.createElement('span', { className: 'dsq-pillwrap' }, [
          button,
          react.createElement('span', { className: 'dsq-pill-note', key: 'n' }, note),
        ])
      }

      // 5) 挂载：会话域桥 + 浮层工具条 + 子会话回流按钮
      ctx.inject(['slots'], function (scope) {
        var slots = scope.slots
        if (slots === undefined || slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.error('[dsh-quote-chip] slots 服务不可用，工具条未注册')
          return
        }
        slots.inject('conversation.composer.dock', function* () {
          yield slots.register({ name: 'conversation.composer.dock', id: 'quote-chip-bridge', order: 950 }, Bridge)
        })
        slots.inject('shell.overlay', function* () {
          yield slots.register({ name: 'shell.overlay', id: 'quote-selection-toolbar', order: 40 }, Toolbar)
        })
        slots.inject('conversation.input.right', function* () {
          yield slots.register({ name: 'conversation.input.right', id: 'quote-chip-recap', order: 60 }, RecapButton)
        })
      })
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
