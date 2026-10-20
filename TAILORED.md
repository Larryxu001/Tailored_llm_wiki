# LLM Wiki Tailored（定制版）

基于 [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) v0.6.12。界面和功能与原版完全相同，只改了下面几处。改动集中在新增文件里，便于以后合并上游更新。

## 改了什么

| 改动 | 说明 | 主要文件 |
|---|---|---|
| Agent 摄入 | 每份原文只调用一次 Codex CLI / Claude Code。agent 读一遍原文，自己找到免责声明/disclosure 的起点，只摄入之前的正文；输出语言不同时全文翻译到 `raw/translations/`；直接改写已有页面。应用负责收尾：目录、日志、待审阅、摄入缓存、向量索引。原版多步流程保留，可在设置中切回 | `src/lib/agent-ingest.ts` |
| 原文目录松绑 | `raw/` 下任意文件夹都算原文，例如 `raw/海外投行/2026-10/`。`raw/assets`、`raw/parsed`、`raw/translations` 和隐藏文件夹除外；原来的 `raw/sources/` 照常可用 | `src/lib/raw-layout.ts`、`file_sync.rs` |
| Agent 体检 | 每批摄入完成后，自动检查本批改动的页面，另按设定周期做全库体检。读完整页面，机械问题直接修复，判断题进入待审阅 | `src/lib/agent-lint.ts` |
| Agent 设置 | 设置 → Agent 模式：模型从本机 `~/.codex/models_cache.json` 读取，可选推理强度与 Fast 速度；Claude 使用别名，始终指向最新模型 | `agent-section.tsx`、`agent-models.ts` |
| 只用订阅额度 | Agent 运行时去掉 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等环境变量，使用命令行登录的订阅账号（可关闭） | `codex_cli.rs`、`claude_cli.rs` |
| 活动面板 | 拖动顶部边缘可调整高度，双击恢复默认 | `activity-panel.tsx` |
| 应用身份 | 名称 LLM Wiki Tailored，标识 `com.llmwiki.tailored`，绿色图标；可与原版同时运行，设置互不影响；检查更新指向本仓库 | `tauri.conf.json` |
| 修复原版 bug | 退出应用后 Claude/Codex 子进程不结束，继续消耗额度 | `lib.rs` |

## 首次使用

1. **编译**：`npm ci && npm run tauri build -- --bundles app`。需要 Rust 和 Node。产物在 `src-tauri/target/release/bundle/macos/`。
2. **登录命令行**：在设置 → LLM 模型中选择 Codex CLI 或 Claude Code，确保终端里已经用订阅账号登录过 `codex` / `claude`。
3. **授权**：第一次运行时，macOS 会请求访问“iCloud 云盘”“文稿”等文件夹，请点“允许”。Codex 的技能目录常常指向 iCloud，不授权的话 agent 会卡住。卡住超过 5 分钟会自动停止并提示。也可以在“系统设置 → 隐私与安全性 → 文件与文件夹”中手动开启。
4. **设置输出语言**：设置 → 输出，选“中文”，英文研报就会自动全文翻译。

## 内容规则

摄入和体检的内容标准，完全由知识库根目录的 `purpose.md`、`schema.md`（以及它们引用的规则文件，如 `taxonomy.md`）决定，应用代码里没有写死。调整收录标准只需改这些规则文件。
