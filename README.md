# dsh-quote-chip

DSH web 插件：选中对话正文 → 浮条「引用」把选中内容作为**不可编辑的引用芯片**插入输入框；
浮条「向子代理提问」把引用 + 你的问题组成一条消息交给当前会话的 subagent 工具去问。

## 为什么必须是常驻插件

动态 Cordis Package（`cordis_define` / `cordis_run`）被 Client Guard 明确禁止拿到别人的
context：

```
service "sessions" returned a cordis Context, which the dynamic facade does not expose.
Operate through your own plugin ctx and the services you declared — never another context.
```

拿不到会话作用域，就派发不了 `slash/input-insert-reference` 这个作用域事件，也就插不出
编辑器原生引用芯片。常驻插件没有这层限制。

## 两个动作

| 动作 | 行为 |
| --- | --- |
| 引用 | 向会话作用域派发 `slash/input-insert-reference`，由输入框自己在草稿最前面插入一枚 reference chip（`source: 'quote'`）。芯片只能整枚删除，**改不了里面的字**；你接着写的正文不会被吞进引用块（芯片的 clipboard/ref 以空行结尾）。发送时由本插件注册的引用源 codec 还原成下面这种形态（历史里仍是标准 Markdown 引用块，前后带显式边界，模型不会把引用当成用户自己的话）：

```
【引用】
> 选中的第一行
> 选中的第二行
【引用结束】

你自己的话
``` |
| 向子代理提问 | 把「指令 + 我的问题 + 引用块」写进草稿并（等草稿真正就位后）自动提交，由当前会话的 `subagent` 工具发起询问。**只有一种语义：后台可续聊**（指令写死 `run_in_background: true`）。草稿非空时拒绝覆盖并提示，绝不吃掉用户正在打的字。**子代理会话里这个动作整个不出现**（只留「引用」），避免孙代理层层套下去。 |

### 为什么只保留后台可续聊

DSH 的 `subagent` 工具是 `backgroundMode: continuable`（见 `presets/*/agent.cordis.yml`），但
`dsh-tool-subagent` README 写明：continuable 策略下 `run_in_background: false` 是"前台等结果"，
**前台那条路产出的是 one-shot 子代理**（只读会话、不可续聊、不出现在 `list_agents` 里）。

前台一次性曾经做过一版，被去掉了：它的结论作为工具结果回流到父会话，而"只是解析一段概念"这种
结果对父会话没有价值，纯属往父上下文里塞 token。

现在只走 `run_in_background: true` → continuable 子代理。`dsh-client-ui-subagent` README：
*"A continuable child with a live parent keeps the ordinary input chrome"* —— 它的会话输入框可用，
可以一边看主代理跑一边直接追问它；追问走它的 FIFO 收件箱，另带独立 Stop。

### 子代理会话里的自我保护

判定"当前会话是不是子代理会话"用**两个来源，任一命中即可**：

| 来源 | 字段 | 什么时候有值 |
| --- | --- | --- |
| 会话快照 | `sessionSnapshot.subagent`（`{ address, parentAvailable? }`） | 只有会话控制器配置过 address 时才有值 —— 例如**经子代理目录/导航打开**的那个会话 |
| 会话列表 | `SessionSummary.origin === 'subagent'`（另有 `parentSessionId`） | 持久标记，**一直有** |

只查前者会漏：直接切进子会话时 `subagent` 可能仍是 `null`，于是浮条会错渲染出「向子代理提问」。
两个来源都查之后，**子代理会话里浮条只渲染「引用」**。

**这道闸门只装在这层 UI 上**：挡住的是"用户在子代理会话里通过浮条再开一层"，**不是**禁止代理委派 ——
主代理（或子代理自己）在任务需要时仍然可以调用 `subagent`。所以插件**不**去禁用它的工具，也**不**在
交给它的任务里写"不许再开子代理"。

真要能力级硬拦（任何路径都绕不过）才需要动 preset：给 `subagent` 行加 `maxDepth: 1`（子代理再派一律被拒），
或用 `toolFilter: { deny: [...] }` 从子代理的工具表里去掉这两个工具。DSH 当前的默认 `maxDepth` 是 **3**。
preset 不能直接改 ship 的那份，得复制到 `$DSH_HOME/.agent-presets/<id>/` 再切过去。

### 关键发现：结束通知只带"最后一步"的文字（2026-09-18 实验验证）

派一个子代理按三步执行：① 长篇解释 → ② 调一次 `todo_write` → ③ **最后一步只输出「已答」两个字**。
父会话实际收到的结束通知**只有「已答」**。

⇒ 通知不是"整轮全部文字"，而是**该轮最后一步的助手文本**。父会话还收不到子会话的中间步骤、工具调用，
以及**用户对子代理说的话**（那些只在子会话里）。

### 当前设计（v6）：子代理回到默认 + 「主代理介入」= 让它自己写简报

**引用路径派出的子代理完全走 DSH 默认**：任务里**不写任何收尾协议**。它每轮的最后一段话（通常就是它给你的
正式回答）会照默认行为回流给主代理。用户要"零污染"时用独立会话，不靠协议。

**「主代理介入」按钮**挂在 `conversation.input.right`（输入框工具行），**只有子代理会话才渲染**。点一下 =
往该子会话发一条本轮指令（实测子代理会照做）：

> 【主代理介入】请把这次对话整理成一份给主代理的简报：结论、关键依据、以及你不确定或未验证的地方。
> 篇幅你自己判断，宁可具体也不要空泛 —— 这份简报会作为你的收尾消息回流给主代理。

它写好 → 收尾消息自动回流给主代理。**主代理不翻日志**，只多收一段文本。

**为什么不是主代理读日志**（v5 试过，撤回）：

| | 让它写简报 | 主代理读日志 |
|---|---|---|
| 主代理的上下文 | 一段简报（几百 token） | 抽出来的若干条 |
| **主代理侧的花费** | 派活 + 一条收尾 | **N 次工具往返 × 整个主上下文**（实测一轮介入让会话累计涨了 ~3M） |
| 内容 | 它自己总结的（知道对话发生了什么，更准、可读） | 原文全量，但要主代理自己筛 |
| 子代理花费 | 多跑一轮 | 0 |

结论：**摘要由知道对话的它来写更划算**。日志仍然是**取证/核实**的备用通道（比如怀疑它美化、要看用户原话）；
读日志的脚本要处理它**多帧 zstd 拼接**、Node 只解第一帧的问题（本仓库未附带）。

**主代理自己派的子代理同样不受影响**：插件只给主代理写消息，主代理自己 `subagent()` 出来的孩子任务里
也没有任何协议。

历次版本：

| 版本 | 形态 | 结局 |
| --- | --- | --- |
| v1 | spawn 时的「结论回流」勾选框 | 删：预授权，和"聊完了再决定"不是一回事 |
| v2 | 浮条上的「回流结论」按钮 | 删：浮条应该是固定两个动作 |
| v3 | 「结论回流」常驻开关 | 删：常驻状态会漂；且静默不省 token |
| v4 | 默认「已答」协议 + 回流按钮（三句总结） | 删：协议会漂；"三句"太薄 |
| v5 | 默认无协议 + 介入按钮只发信号、主代理读日志 | 删：主代理侧要 N 次工具往返 × 大上下文，最贵的一版 |
| **v6（当前）** | 默认无协议 + 「主代理介入」让子代理自己写简报回流 | 采用 |


### 作用范围（重要）

插件**没有能力**改主代理的工具、工具描述或 preset，也**不限制**代理的委派能力。它只做一件事：用户点按钮时
往某个会话的输入框里写一条消息；真正执行 `subagent()` 的永远是主代理。所以：

* 浮条只影响被点的那一次交互；
* 主代理今后自己为了干活发起的子代理**完全不受影响** —— 它照旧用 `send_message` 主动拉、或按 id 读会话；
* 子代理会话里不渲染「向子代理提问」只是这一层 UI 的闸门，挡的是"你在子会话里再点一层"，不是"代理不能再委派"。
* 提醒：**子代理自己也持有 `send_message`，可以主动给父会话推消息**（实测遇到过它既写收尾又额外推一份，
  同一内容到我这里两份）。这是那条 push 通道关不掉的部分，只能在交给它的任务里写明"不要额外推送"。

### 共享与 token

* 父会话**不会**拿到子会话的完整对话："Intermediate child steps stay out of the parent"、
  "the child's transcript by its id is the source of its detailed output"。
* continuable 子代理只在**一段工作结束时**回一条 service-owned 结束通知（怎么结束的 + 最后一条助手消息），
  这条通知会进父会话历史、并在压缩前被每次父请求重发 —— 这是共享的全部成本。
* 用户直接开子会话聊天的那部分内容**完全不进父会话**。
* DSH **没有**"不通知父会话"的开关；要零共享只能用一个与父会话无父子关系的独立会话。


## 降级

* 拿不到 `inputTriggers`（芯片没有 codec 归属，发送时会被卡住）→ 永不使用芯片路径，自动退回"纯文本引用"。
* 拿不到 `sessions` / 会话作用域 / 输入框阶段不是 `plain` → 同上退回纯文本。
* 可编辑区域（Lexical 输入框、其中的芯片节点、普通 input/textarea、`role="textbox"`）内的选区**不会**弹出浮条。

## 文件

```
dsh/index.js       host 半：故意为空，只为让 bundle 有一行、client 半被 dsh.client 发现
dsh/client.js      全部功能：引用源注册 + 会话域桥 + 浮层工具条
cordis.patch.yml   bundle patch：insert 一行 dsh-quote-chip
test/smoke.mjs     离线自测（纯 node，不需要 DSH）
LICENSE            MIT
```

## 安装

1. 克隆到任意本地目录：

   ```powershell
   git clone https://github.com/Autumn-oy/dsh-quote-chip.git
   ```

2. 编辑 `$DSH_HOME/profiles/web/package.json`（`$DSH_HOME` 为 DSH 数据目录，`dsh --profile web --dump-config`
   打印的配置里能看到它在哪）：

   * `dependencies` 加 `"dsh-quote-chip": "link:<克隆目录>/dsh-quote-chip"`
   * `dsh.profile.bundles` 加 `"dsh-quote-chip"`

3. 安装并预检，然后重启 dsh web：

   ```powershell
   dsh plugin --profile web install          # 或在 profile 目录里 pnpm install
   dsh --profile web --dump-config           # 预检：组合树里应出现 dsh-quote-chip
   # 重启：设置 → 本地服务 → 重启
   ```

## 回滚

1. 恢复 `package.json`（改之前自己留的 `.bak-*`，或手动删掉上一节加的两处）；
2. 同一个目录 `pnpm install`；
3. 重启 dsh web。

只想去掉插件而不动依赖：把 `dsh.profile.bundles` 里的 `"dsh-quote-chip"` 一行删掉再重启即可
（bundle patch 不再应用，host 行与 client 半都不加载）。

## 离线自测

`test/smoke.mjs`（`node` 直接跑，不需要 DSH，路径相对本仓库解析）：

```powershell
node test/smoke.mjs
```

用假的 React/DOM/宿主环境验证 10 组场景：有 inputTriggers 走芯片、无 inputTriggers 降级文本、
向子代理提问的组消息与提交、「主代理介入」简报、草稿非空拒绝覆盖、输入框内选区不弹浮条、
子代理会话的浮条降级与自我保护等。全部断言通过会打印 `ALL CHECKS PASSED`。

## License

[MIT](LICENSE) © 2026 Autumn-oy
