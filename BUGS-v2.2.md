# FJMU 自动评教助手 v2.2 —— 问题诊断

> 对象：[ScriptCat #5233](https://scriptcat.org/zh-CN/script-show-page/5233) 发布的 `FJMU自动评教助手` v2.2
> 本地副本：[fjmueval-v2.2.user.js](original/fjmueval-v2.2.user.js)（1074 行）
> 结论：**不是"某个选择器过期"这种小毛病，而是自动化流程的架构本身跑不通。**

---

## 一、致命问题：循环活不过一次页面跳转

这是"评完第一门就停 / 一门都没评完 / 日志显示全部完成但其实没评"的直接原因。

| # | 位置 | 问题 |
|---|---|---|
| 1 | [L886–989](original/fjmueval-v2.2.user.js#L886-L989) | `startAutoEvaluation()` 用 `while (!stopRequested)` 在**一个页面的 JS 上下文里**跑完整轮课程。点「去填写」会整页跳转，`document` 被替换，脚本上下文随之销毁 —— `while` 循环根本走不到第二轮。 |

**旁证**：脚本头部声明了 `@grant GM_setValue / GM_getValue`（[L10–11](original/fjmueval-v2.2.user.js#L10-L11)），但全文**一次都没有调用**。说明作者本来想用 GM 存储做跨页状态传递，写完循环就忘了。所以"很久没更新 + 有 bug"的根源在这里。

| # | 位置 | 问题 |
|---|---|---|
| 2 | [L949–956](original/fjmueval-v2.2.user.js#L949-L956) | 点击「去填写」后**没有等待页面就绪**，直接 `fillEvaluationForm()`。若已跳转，这行跑在新页面上必然找不到输入框，只会在日志里刷"未找到第 N 题的输入框"。 |
| 3 | [L914–921](original/fjmueval-v2.2.user.js#L914-L921) | 提交完成后没有"回到列表"的动作。下一轮 `findEvaluationButtons()` 在表单页必然返回空数组 → `break` → 打印「所有课程评教完成！」并弹完成通知。**假成功**，最误导人。 |

---

## 二、危险问题：可能重复提交

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| 4 | [L666–692](original/fjmueval-v2.2.user.js#L666-L692) | `simulateRealClick()` 对同一个元素触发了 **3 个 click 事件**：`el.click()` → 4 个鼠标事件（含第 2 个 click）→ `focus()` → 第 5 个 `click` 事件。 | 在"确认提交"弹窗的「确定」上，等于连点 3 次。 |
| 5 | [L714–727](original/fjmueval-v2.2.user.js#L714-L727) | 备用方案里又叠了 `link.click()` + `link.onclick()` + 再一次 `dispatchEvent`。 | 与 #4 叠加，单个弹窗最坏触发 5 次点击。教务系统常见的「重复提交」「该课程已评价」报错多由此产生。 |

评教是一次性写库操作，这个风险等级应该按 P0 看。

---

## 三、逻辑错误

| # | 位置 | 问题 |
|---|---|---|
| 6 | [L926](original/fjmueval-v2.2.user.js#L926) / [L935](original/fjmueval-v2.2.user.js#L935) | `let i = 0` 之后 `i` 再没变过，`buttons[i].click()` 永远点第一个；而日志却打印「点击第 `${i+1}` 个」。`if (i < buttons.length - 1)` 恒真，于是**同一门课被无限重复点击**（每轮约 7 秒一次）。 |
| 7 | [L936–940](original/fjmueval-v2.2.user.js#L936-L940) | `catch` 里 `if (!inputElement) continue;` —— 这个 `continue` 跳过了后面所有 `await`，异常持续时变成**无延迟紧密空转**，CPU 打满 + 日志狂刷。 |
| 8 | [L911](original/fjmueval-v2.2.user.js#L911) | 探测"是否在表单页"用了 `#scroll_${1}`（=`#scroll_1`，第 2 题），正确应是 `_0`。 |
| 9 | [L823](original/fjmueval-v2.2.user.js#L823) | 弹窗处理失败也 `return true; // 即使弹窗处理失败，也认为提交成功`，把失败当成功，掩盖真实状态。 |
| 10 | [L743](original/fjmueval-v2.2.user.js#L743) | `querySelector('a:contains("确定"), ...')` —— `:contains()` 不是合法 CSS，**必然抛 `SyntaxError`**，整个 fallback 分支进 catch 直接返回 false。这段代码从上线起就没生效过。 |
| 11 | [L433–450](original/fjmueval-v2.2.user.js#L433-L450) | `Set` 去重的是 DOM 元素本身；父子 `div` 若都命中文本「去填写」，同一门课会产出 2 个按钮 → 被填两次。 |
| 12 | [L531](original/fjmueval-v2.2.user.js#L531) | 总分 ≥70 时执行 `textarea.value = ""`，会**主动清空**用户已写的评语。 |
| 13 | [L544–555](original/fjmueval-v2.2.user.js#L544-L555) | 总分计算与填写都写死 5 题；题目数量一变，总分算错、后面的题空着，提交被拦。 |
| 14 | [L494](original/fjmueval-v2.2.user.js#L494) | `(maxScore * pct).toFixed(2)` 产生 `12.75` 这类值；若 input 带 `step="1"` 或后端只收整数，会校验失败。 |

---

## 四、稳健性 / 体验

| # | 位置 | 问题 |
|---|---|---|
| 15 | [L246–253](original/fjmueval-v2.2.user.js#L246-L253) | 每条 `success`/`error` 日志都发一次 `GM_notification(timeout:3000)`。连着评十几门课时系统通知会疯狂弹。 |
| 16 | [L257–266](original/fjmueval-v2.2.user.js#L257-L266) | 日志用 `innerHTML` 拼接未转义文本（低危，但页面文本含 `<` 会破版）。 |
| 17 | [L7](original/fjmueval-v2.2.user.js#L7) | `@match` 只有 `*://*.jxzhpt.webvpn.fjmu.edu.cn/*`。走 `webvpn.fjmu.edu.cn/https/xxx` 路径式 WebVPN、或直连域名时脚本**根本不加载**。 |
| 18 | 全文 | 无 `@noframes`、也不判断 `window.top`。WebVPN 若用 iframe 承载，面板会在每个 frame 各生成一份，各自独立点击。 |
| 19 | [L354–357](original/fjmueval-v2.2.user.js#L354-L357) | 面板「关闭」后只能靠刷新恢复。 |
| 20 | [L423–431](original/fjmueval-v2.2.user.js#L423-L431) | `wait()` 对**任何** >100ms 的等待都叠随机延迟，包括弹窗 200ms 轮询（实际变成 200–700ms），白白拖慢。 |
| 21 | — | 没有"先试一门 / 只填不交"的保险开关。一次性写库操作却默认全自动提交，首次使用的风险偏高。 |

---

## 五、为什么"自动评教"实际只处理了 0～1 门

把链路串起来看：

```
列表页 → 点第1个「去填写」
      → 整页跳转（脚本上下文销毁，while 循环死亡）
      → 新页面：面板重新出现，状态="就绪"，巡航标记丢失
      → 用户必须手动再点一次「开始」
```

也就是说 v2.2 的"循环处理所有课程"在真实页面上**从未成立**。如果恰好在同一页用弹窗/SPA 方式打开表单，才会跑完一门，然后卡在 #3 的假成功提示上。

---

## 六、v3.0 对应改法

| v2.2 问题 | v3.0 做法 |
|---|---|
| 跨页循环死亡（#1/#2/#3） | 改成**跨页面状态机**：状态写 `GM_setValue`（无 GM 时退 `sessionStorage`），每张页面加载后读回状态自动续跑；用 `pageToken` 区分"跳转后回到列表"与"点了没反应"。 |
| 重复点击（#4/#5） | `clickOnce()` 严格单击；确认弹窗最多点 1 次；同一表单页有「已提交」保护，回到列表自动解除。 |
| 锚点固定 + 紧循环（#6/#7） | 用 `guarded()` 互斥锁 + 轮询调度，取消 `while`；按课程名签名跳过"点不动"的课程，最多跳过 20 门后熔断。 |
| 非法选择器（#10） | 删除 `:contains`，改为"可见性 + 文本 + 弹窗容器"三重判定。 |
| 写死 5 题（#12/#13） | 遍历页面上所有 `.rater_input`，每题从 `.fscore`/题干/属性读满分；题数变化自动适配；总分不达标才写评语，且不覆盖已有内容。 |
| 分值精度（#14） | 可按 1 / 0.5 / 0.1 取整，默认 0.5。 |
| 通知轰炸（#15） | 只在任务结束/熔断时通知一次。 |
| 域名单一（#17/#18） | 补全 6 条 `@match`；判断 `window.top`，非顶层 frame 且不是评教页直接不介入。 |
| 面板关不掉（#19） | 折叠 / 关闭 + 右下角 🐟 悬浮块唤回，可拖动并记忆位置。 |
| 首次使用无保险（#21） | 默认**不启动**，需手动点「开始巡航」；另有「填写当前页」按钮（只填不交）。 |
