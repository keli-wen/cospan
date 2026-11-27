<p align="center"><img src="assets/logo/cospan.svg" width="330" alt="COSPAN"></p>

<p align="center"><a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="https://antigravity.google/product/antigravity-cli"><img src="assets/badges/antigravity-plugin.svg" height="20" alt="Antigravity: plugin"></a> <a href="https://developers.openai.com/codex/"><img src="assets/badges/codex-plugin.svg" height="20" alt="Codex: plugin"></a><br>
  <a href="https://claude.com/claude-code"><img src="assets/badges/claude-code-plugin.svg" height="20" alt="Claude Code: plugin"></a> <a href="#安装"><img src="assets/badges/dsh-plugin.svg" height="20" alt="DeepSeek Harness: plugin"></a><br>
  <a href="LICENSE"><img src="assets/badges/license-mit.svg" height="20" alt="license: MIT"></a>
</p>

**跨 Coding Agent 的统一后台协作。**
用一套异步派活协议把 **Antigravity**、**Codex**、**Claude Code**、**DeepSeek Harness** 和 **Grok Build** 串起来，让 AI 之间自己互相调用（更多工具陆续接入中）。

[![Cospan 连接 Antigravity、Codex、Claude Code 与 DeepSeek Harness](assets/design.png)](assets/design.svg)

**[40 秒演示](#40-秒演示) · [为什么做 Cospan](#为什么做-cospan) · [常见用法](#常见用法) · [安装](#安装) · [支持的工具与模型](#支持的工具与模型) · [路线图](#路线图) · [参考与许可](#参考与许可)**

## 40 秒演示

https://github.com/user-attachments/assets/43384bfd-ca36-4d6b-9074-84ca5257cc20

## 为什么做 Cospan

各家强力编程模型，往往都是在自家配套的客户端和工具链里调教得最好——所以真正该被调用的最小单位其实是**“模型 + 它自家的原生客户端”**。不同模型各有擅长：**Gemini 4 Carbon**（`agy`）适合做架构设计和方案规划，**GPT-6.2-Sol**（`codex`）适合深挖代码漏洞做 Review，**GPT-6.1-Terra**（`codex`）适合配合 Codex 直接操作浏览器测页面，而 **Claude**（`claude`）写前端界面和交互细节很稳。以前想把它们配合起来，只能人肉在不同窗口之间来回复制粘贴“传话”；现在可以让当前对话里的 AI 直接把活派给另一家。

沿用了 [`agy-staff`](https://github.com/keli-wen/agy-staff) 验证过的思路，Cospan 把跨客户端派活做成了**默认丢到后台跑、结果按需看**的模式：主对话把任务发出去之后不会卡住，也不会被对方翻文件、跑命令的过程刷屏——平时只收回总结好的结论，真要盯进度或查完整执行记录时再拉取即可，省上下文也省精力。

![Why Cospan 极简线条插画：从人肉传话（You are the router）变成让 AI 之间直接互相派活（Agents orchestrate peers）](assets/why.png)

## 常见用法

### 一句话派活，剩下全自动

直接用 `/cospan-<工具>`（Claude Code 里是 `/cospan:<工具>`，Codex 里是 `$cospan:<工具>`），在指令里写清楚想用的**模型**、**思考深度（effort）**和**超时时间**就行：

```text
/cospan-codex 用 sol（high effort，20m 超时）审查 src/webhook/ 的改动，找出可能漏掉的边界问题。
```

> [!TIP]
> **背后的流程不用你操心：** 收到指令后，你当前使用的 AI 会自动整理任务（文字太长会自动写成临时文件）、丢到后台启动（`send`）、在后台安安静静等结果（`wait`）或按需瞄一眼进度快照（`observe`），拿到报告后还能在同一段会话里接着追问（`continue`）。

### 统一任务侧边栏（`agy` 和 `dsh`）

装在 **Antigravity (`agy`)** 或 **DeepSeek Harness (`dsh`)** 里时，还会多出一个统一的 Cospan 侧边栏——五家的后台任务走到哪一步、你问了什么、对方答了什么都能点开看，同一个仓库下不同 Git worktree（`wt:*`）的任务也会自动归到一起（[安装方式 ↓](#安装)）：

<p align="center">
  <img src="assets/sidebar-extension.png" width="420" alt="Antigravity (agy) 与 DeepSeek Harness (dsh) 中的 Cospan 统一侧边栏面板截图，展示 Codex、Claude Code、Antigravity worktree 与 DeepSeek Harness 并行任务">
</p>

### 跨工具配合的几个常见场景

- <img src="assets/badges/cuj-parallel-review.svg" height="18" alt="Parallel Review"> **后台同时派 2 个 Sol 分头查代码** _（Antigravity → 2× Codex）_ — 把 `webhook/` 和 `retry/` 两个模块的排查拆给两个 `sol` 并行去查，你本地照常跑单测、改代码，两头互不耽误，谁查完结果自动回来汇总：

  > `/cospan-codex` _“同时派 2 个 `sol` 分别审查 `webhook/` 与 `retry/` 的改动，找出真正的 Bug。”_

  ![Gemini 4 Carbon 使用 2 个并行 GPT-6.2-Sol 在后台同时审查 webhook/ 与 retry/](assets/cuj-carbon-sol.svg)

- <img src="assets/badges/cuj-second-brain.svg" height="18" alt="Second Brain"> **请 Carbon 当第二大脑多轮把关方案** _（Codex ⇄ Antigravity）_ — 用 Astra 写代码时让另一家模型帮着挑 `docs/plan.md` 方案里的毛病、问有没有更稳的改法，同一段上下文还能接着追问崩溃恢复细节，主窗口不用干等：

  > `$cospan:agy` _“请 `carbon` 帮忙看看 `docs/plan.md` 方案哪里有盲点、有没有更简洁的做法，并继续核实崩溃恢复。”_

  ![GPT-6.2-Astra 跨 2 轮咨询 Gemini 4 Carbon，挑刺 docs/plan.md 并核实崩溃恢复](assets/cuj-astra-carbon.svg)

- <img src="assets/badges/cuj-computer-use.svg" height="18" alt="Computer Use"> **把打开浏览器实测页面的活交给 Terra** _（Claude Code → Codex）_ — 主线留在 **Claude Sonnet** 写代码、跑单测，把“打开本地网页、实际走一遍结账优惠券流程、看看手机屏幕下有没有遮挡”交给 **GPT-6.1-Terra** 去点点看：

  > `/cospan:codex` _“让 `terra` 打开本地应用，实际走一遍结账优惠券流程并检查界面状态。”_

  ![Claude Sonnet 让 GPT-6.1-Terra 打开浏览器，在 375px 下测试 SAVE20 并抓出移动端按钮遮挡 Bug](assets/cuj-claude-terra.svg)

- <img src="assets/badges/cuj-fast-sidecars.svg" height="18" alt="Fast Sidecars"> **把翻代码和跑核查分给快又省的模型，替 Fable 省额度** _（Claude Code → Antigravity + DeepSeek Harness）_ — 一边让 `hydrogen` 去梳理鉴权刷新入口，一边让 `v4.1-flash` 去查并发 401 下的锁竞争，主对话保持干净，不浪费旗舰模型上下文和额度：

  > _“让 `hydrogen` 快速梳理鉴权刷新入口，同时让 `v4.1-flash` 核查并发 401 下的锁竞争。”_

  ![Claude Fable 并行将鉴权梳理交给 Gemini 4 Hydrogen，将竞争核查交给 DeepSeek V4.1 Flash](assets/cuj-fanout-sidecars.svg)

- <img src="assets/badges/cuj-full-pipeline.svg" height="18" alt="Full Pipeline"> **让 Carbon 当总管，串起多模型接力干完整套流程** _（Antigravity ⇄ Codex + ×N Antigravity）_ — 先请 `astra` 审方案，再并发派多个 `hydrogen` 跑完各组实验，然后交给 `sol` 做最终审查，最后把 `sol` 提的修改意见退回给 `hydrogen` 收尾改干净：

  > _“先让 `astra` 审查我的方案，再同时派 `hydrogen` 跑完各组实验，接着让 `sol` 做最终审查，并把 `sol` 的建议交回 `hydrogen` 过最后一遍。”_

  ![Carbon 作为主控与 Astra 敲定方案，派 Hydrogen ×N 并行做实验，经 Sol 审查后由 Hydrogen 完成最后一轮修改](assets/cuj-research-pipeline.svg)

## 安装

需要 **Node.js `>= 20`** 以及你想调用的命令行工具（`agy`、`claude`、`codex`、`dsh`、`grok` 装了哪几个就能连哪几个）。

> [!TIP]
> <img src="assets/icons/cospan-pixel.svg" width="16" height="16" alt=""> **推荐方式 — 直接让 AI 帮你安装：** 把下面这段话发给你正在用的任意 Coding Agent，它会自动识别你的系统与客户端完成安装并做体检：
>
> ```text
> 请读取 https://raw.githubusercontent.com/keli-wen/cospan/master/docs/INSTALL_FOR_AGENTS.md 的原始内容
> （用 curl 拉取原文，不要只看摘要），按里面的步骤为当前客户端安装并验证 Cospan，最后用中文告诉我结果。
> ```

### 手动安装

**Antigravity (`agy`)**

```bash
git clone https://github.com/keli-wen/cospan.git ~/.cospan/repo
node ~/.cospan/repo/bin/cospan.mjs install --host agy
```

**Claude Code (`claude`)**

```bash
claude plugin marketplace add keli-wen/cospan
claude plugin install cospan@cospan
```

**OpenAI Codex (`codex`)**

```bash
codex plugin marketplace add https://github.com/keli-wen/cospan
codex plugin add cospan@cospan
```

**DeepSeek Harness (`dsh`)**

```bash
dsh plugin --profile desktop add github:keli-wen/cospan
```

_（也可以直接在 DeepSeek Harness 桌面端侧边栏 **Plugins** 里填 `github:keli-wen/cospan` 安装。）_

装完记得重启一次 Claude Code 或 Codex 让插件生效（Antigravity 与 DeepSeek Harness 里用 `/cospan-…`，Claude Code 里用 `/cospan:…`，Codex 里用 `$cospan:…`，或者直接用大白话吩咐它干活也行）。

<details>
<summary>更新插件与健康检查</summary>

- **Antigravity (`agy`)**：`git -C ~/.cospan/repo pull --ff-only && node ~/.cospan/repo/bin/cospan.mjs install --host agy`
- **Claude Code (`claude`)**：`claude plugin marketplace update cospan && claude plugin update cospan@cospan`
- **OpenAI Codex (`codex`)**：`codex plugin marketplace upgrade && codex plugin add cospan@cospan`
- **DeepSeek Harness (`dsh`)**：`dsh plugin --profile desktop add 'github:keli-wen/cospan#<tag-or-commit>'`

Claude Code 和 Codex 会按版本号缓存插件，更新完要重启客户端才能生效。随时可以跑 `node <cospan路径>/bin/cospan.mjs doctor --check`（不消耗任何模型额度）检查五家 CLI（`agy`、`codex`、`claude`、`dsh`、`grok`）路径和参数是否正常；Windows 写法和缓存强制刷新细节见 [docs/INSTALL_FOR_AGENTS.md](docs/INSTALL_FOR_AGENTS.md)。

</details>

## 支持的工具与模型

| 客户端                       | 模型家族                 | 内置模型简写                                                     |
| ---------------------------- | ------------------------ | ---------------------------------------------------------------- |
| **Antigravity** (`agy`)      | Google · Gemini & Claude | `flash`, `neon`, `carbon`, `argon`, `hydrogen`, `opus`, `sonnet` |
| **Codex** (`codex`)          | OpenAI · GPT             | `sol`, `terra`, `astra`, `luna`                                  |
| **Claude Code** (`claude`)   | Anthropic · Claude       | `sonnet`, `opus`, `haiku`, `fable`                               |
| **DeepSeek Harness** (`dsh`) | DeepSeek 及自定义提供商  | `v4.1-flash` / `flash`, `v4-pro` / `pro`, `<provider>/<model>`   |
| **Grok Build** (`grok`)      | xAI · Grok               | `build`, `fast`                                                  |

_后续还会陆续接入更多工具——Cospan 的驱动层设计得比较轻量，接入新的编程 Agent CLI 很方便。_

## 路线图

- [ ] **基于 SSH 的跨机对等委派** — 通过短连接 SSH（局域网 / Tailscale）将任务异步投递给另一台机器闭环执行并按需取回结果，无需挂长连接，远端凭据与敏感环境留在本地。

## 参考与许可

- **[`agy-staff`](https://github.com/keli-wen/agy-staff)** — 把 Google Antigravity CLI（`agy`）作为快速帮手和第二大脑接入 Claude Code、Codex、DeepSeek Harness、Pi 与 OpenCode。Cospan 把 `agy-staff` 里率先跑通并做过评测（[Bench v1 技术报告](https://lastwhisper.dev/zen-of-harness-engineering/agy-staff-bench-v1/)）的后台任务与按需查看结果这套机制，进一步推广成了各家工具之间互相派活的通用插件。
- **社区** — [LINUX DO](https://linux.do/)（新的理想型社区，_Where possible begins_），欢迎交流使用经验。
- **许可证** — [MIT](LICENSE) © 2026 Keli Wen · 发布说明见 [`docs/releases/`](docs/releases/) · 架构与工程规范见 [`AGENTS.md`](AGENTS.md)。
