# FJMU 自动评教助手 · v3.1.1

针对福医大评教系统（`jxzhpt.webvpn.fjmu.edu.cn`）重写的油猴脚本。基于 ScriptCat 上的
[FJMU自动评教助手 v2.2](https://scriptcat.org/zh-CN/script-show-page/5233) 修复，原版问题清单见
[BUGS-v2.2.md](BUGS-v2.2.md)。

- 新脚本：[src/fjmueval.user.js](src/fjmueval.user.js)
- 原版备份：[original/fjmueval-v2.2.user.js](original/fjmueval-v2.2.user.js)
- 测试：`node tests/run.js`（jsdom 模拟页面，32 项断言全过）

---

## 🚀 一键安装

> 需要先装 [ScriptCat](https://scriptcat.org/) 或 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
> 脚本**只匹配福医大评教系统的域名**，装到别的站点上不会激活。

| 线路 | 安装地址 |
|---|---|
| GitHub 直连 | [fjmueval.user.js](https://raw.githubusercontent.com/YOUR_GITHUB_ID/fjmueval-userscript/main/src/fjmueval.user.js) |
| jsDelivr 国内加速 | [fjmueval.user.js](https://cdn.jsdelivr.net/gh/YOUR_GITHUB_ID/fjmueval-userscript@main/src/fjmueval.user.js) |

点开链接，扩展会弹出安装页，点「安装」即可。国内访问 `raw.githubusercontent.com` 常被墙，
优先用 jsDelivr 那条。

<details>
<summary>手动安装（一键链接打不开时）</summary>

1. 打开 ScriptCat / Tampermonkey 的「管理面板」→「新建脚本」。
2. 清空模板，把 `src/fjmueval.user.js` 全文粘进去，保存。
   （或者直接把 `.user.js` 文件拖进浏览器窗口，扩展会弹出安装页。）
3. 打开评教系统，右上角出现「🎯 自动评教 v3.1.1」面板即成功。

</details>

> 若你的系统域名不是 `*.jxzhpt.webvpn.fjmu.edu.cn`，把文件头部的 `@match` 改成实际域名再保存。

---

## 零、关于新版界面（v3.1.1 实测记录）

2026-11 实测，福医大的评教界面是 **SPA + 右侧抽屉**，而且表单装在**同源 iframe** 里：

| 层 | 内容 |
|---|---|
| 顶层 `/static/home/` | 只有外壳，**一个输入框都没有** |
| `iframe[0]` | `/static/vue/vue/#/survery/children/surverySubmit/<id>`，真正打分的页面 |

iframe 内部结构其实和 v2.2 的旧版一致：

```
#scroll_0.servery > div > div#demo > input.rater_input   评分框
span.fscore "30分"                                        满分
div.range > ... > input.range-slider-hidden               滑块
```

于是 v3.1.1 的做法是：**顶层面板 + 顶层直接操作 iframe 的 document**（同源，不需要双实例通信）。

这一版针对真实页面修的几处：

1. `evalDoc()`：自动定位活动文档（顶层 or 同源 iframe），所有 DOM 操作都走它
2. 评分框自适应：`.rater_input` 优先，否则按 `placeholder="输入0 - 30"` / `max` 兜底
3. 满分解析顺序：`.fscore`("30分") → 题干 → `max` → placeholder
4. 提交按钮支持 `div`/`span`/`uni-button`
5. **「提交」按钮要等约 10 秒才可点** → 改成等待可用（最多 22 秒），并识别 disabled class / `pointer-events:none`
6. 确认框不是 weui：改用「可见 + 文本精确 + 位于浮层」通用判定，实测能认出 `本次评分：86.5，请确认提交？`
7. 点「提交」只弹框、真正写库在「确定」上 → 所以提交按钮可安全重试 3 次，但「确定」只点 1 次

实测数据：5 题 90/85/80/85/90% → 27 / 17 / 16 / 13 / 13.5，页面自己算出的「已评分」显示 **86.50**，与脚本一致。

### v3.1.1：SPA 遮挡导致的"假回列表"

实测发现一个隐蔽坑：**打分抽屉打开时，列表页的 67 个「去填写」按钮仍在 DOM 里**，只是被抽屉盖住。
`isVisible()` 只看 `display/visibility`，不看遮挡，于是脚本误判"已经回到列表"，而人眼看到的是还在打分。

修复：

1. `isListPage() = !isFormPage() && 有「去填写」` —— 两者互斥，抽屉开着就不可能是列表页
2. `isFormPage()` 要求"至少一个评分框可见"（抽屉被 v-show 藏起时不算）
3. 提交成功的唯一标准改成 **打分界面真的消失**，不再拿"列表有按钮"当证据
4. 提交后若界面不自动关 → 读页面 toast → 点抽屉「返回」回收；有"成功"字样按成功处理
5. `goFillButtons()` 加 800ms 缓存，67 门课也不会每 1.5 秒全量扫一遍

## 一、使用

```
列表页 → 点「▶ 开始巡航」
        → 自动点第一个「去填写」
        → 跳转后自动填分（可关掉自动提交，先只填一门看看）
        → 提交 → 自动点「确定」
        → 回到列表继续下一门 …… 直到没有「去填写」按钮
```

面板说明：

| 控件 | 作用 |
|---|---|
| 第 1–5 题滑块 | 每题的得分百分比。满分 30 的题设 90% = 27 分 |
| 自动提交 | 关掉后只填写，提交要你自己点（**第一次用建议先关掉试一门**） |
| 总是填评语 | 勾上则每门课都写评语；不勾只在总分低于 70% 时写 |
| 安全延迟 | 每步加 0–400ms 随机延迟，行为更像真人 |
| 随机浮动 | 每门课在滑块基准线上抖动，总分落在 (84,95)，单项不低于满分 60% |
| ▶ 开始巡航 | 清空计数重新开始，状态可跨页面保持 |
| ■ 停止 | 随时停，状态保留，刷新页面后不会自己乱跑 |
| 填写当前页 | 只填当前表单，不提交 |
| 诊断 / 导出 | 把当前页面的元素结构摘要复制到剪贴板（页面改版时用） |


### 随机浮动（v3.1.1）

勾上「随机浮动」后，每门课的分数都会重新生成，而不是固定一套：

- **基准**：五个滑块的百分比依然是"水平线"，随机值围绕它上下浮动
- **总分区間**：严格落在 (84, 95) 开区间内（按百分制）
- **单项下限**：任何一题都不低于本题满分的 60%
- **日志**：每门都会打印实际使用的分数，例如
  `随机浮动：26.5 / 18 / 15.5 / 12.5 / 15，合计 87.5`

算法不是"随便撒点"，而是：先定目标总分 → 按基准比例缩放 → 叠加一组零和扰动（各有差异但总和不变）→ 取整后把偏差补回 → 校验不通过就重新生成。区间和下限写在 `DEFAULT_CFG` 的 `randMin` / `randMax` 里，想改直接改这两个数。

面板可拖动，`–` 折叠，`×` 关掉后在右下角留一个 🐟 悬浮块唤回。

### 安全边界

- 单次最多处理 40 门（`cfg.maxCourses`），运行超过 25 分钟自动停。
- 连续失败 3 次自动熔断并弹出提示。
- 同一个表单页提交后 2 分钟内不会重复提交；回到列表页自动解除保护。
- 点「去填写」后 5 秒内页面没反应，会把该课程标记为跳过（最多跳过 20 门），不会死循环点同一门。

## 二、和 v2.2 的差别

| 维度 | v2.2 | v3.1.1 |
|---|---|---|
| 跨课程流程 | 单页面 `while` 循环，跳转即失效 | 跨页面状态机（GM 存储 + 页面 token） |
| 点击 | 一次动作触发 3–5 个 click 事件 | 严格单击，弹窗最多点 1 次 |
| 题目数量 | 写死 5 题 | 遍历页面上所有 `.rater_input`，自适应 |
| 满分来源 | 写死 30/20/20/15/15 | 从 `.fscore` / 题干 / 属性读取 |
| 分值精度 | `toFixed(2)` | 可选 1 / 0.5 / 0.1 取整 |
| 弹窗选择器 | 含非法 `:contains()`，必抛异常 | 可见性 + 文本 + 弹窗容器三重判定 |
| 失败处理 | 失败也 `return true` | 失败计数 + 熔断，状态如实上报 |
| 页面改版 | 直接失效 | 多路兜底 + 「诊断」导出结构 |

## 三、如果还是跑不通

我无法登录校内 WebVPN，所以 `rater_input` / `#scroll_N` / `.fscore` / `button.submitbtn` /
`.weui-dialog__btn_primary` 这套结构是沿用 v2.2 的假定（作者应该是对着真实页面写的，大概率仍然有效），
但**没有在真实页面验证过**。如果某一步日志报「没找到评分输入框」或「没找到提交按钮」：

1. 在出问题的那一页点面板上的「诊断 / 导出」。
2. 把复制到的文本发到 Issues 里，我按真实 DOM 重新适配选择器。

日志里每一步都有时间戳，报错也都是中文，直接照抄给我最快。

## 四、代码结构

```
src/fjmueval.user.js
├── 0. 常量与默认配置
├── 1. 存储层（GM_setValue 优先，退回 sessionStorage，带 6 小时过期）
├── 2. 小工具（sleep / waitFor / isVisible / clickOnce / nativeSetValue）
├── 3. DOM 适配层  ← 只有这一层依赖学校页面结构，改版时只改这里
├── 4. 日志
├── 5. 核心动作（fillForm / submitForm / backToList）
├── 6. 状态机（stepList / stepForm / tick，guarded 互斥）
├── 7. 运行控制（startRun / stop / finish）
├── 8. 诊断
├── 9. 界面
└── 10. 启动（顶层 frame 判定 + 跨页续跑）
```

调试入口：控制台里 `__MFEVAL__` 暴露了 `cfg`、`DOM`、`actions`、`getState()`，
例如 `__MFEVAL__.cfg.autoSubmit = false` 可以临时改配置。

## 五、开发与测试

```bash
npm install        # 只有 jsdom 一个依赖
node tests/run.js  # 32 项断言，全过即 OK
```

## 免责声明

本脚本仅供**学习浏览器自动化（DOM 操作、跨页面状态机、iframe 交互）**使用。
评教是学生表达真实教学意见的渠道，各校通常要求本人如实填写；使用者需自行判断并承担
由自动化操作带来的全部后果。作者不对任何账号异常、成绩争议或纪律处理负责。
