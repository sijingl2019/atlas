# Atlas 知识库技术文档

> 面向维护者。本文给出当前实现的代码地图、数据契约、调用链、扩展规则、测试和排障方法。架构动机与风险评估见 [知识库设计文档](./knowledge-base-design.md)。

## 1. 技术栈

| 层 | 技术 | 用途 |
|---|---|---|
| 桌面容器 | Tauri 2 | Rust 命令、事件、文件对话框、系统打开 |
| 前端 | React 19 + TypeScript | 知识库 UI |
| 状态 | Zustand | 条目、元数据、链接图和 UI 镜像 |
| 编辑器 | Tiptap 3 / ProseMirror + `tiptap-markdown` | Markdown 富文本编辑和序列化 |
| 树 | `@tanstack/react-virtual` | 大量笔记的虚拟列表 |
| 关系图 | Pixi.js 8 + Matter.js | 绘制、缩放、拖拽和力学布局 |
| Markdown 导出 | `pulldown-cmark` | Markdown 转 HTML |
| HTML 清理 | `ammonia` | 仅用于 `fetch_readable`，当前未用于导出 |
| mention 排序 | `nucleo_matcher` | 标题和目录模糊匹配 |
| 语义索引 | bge-small-zh-v1.5（本地 embedding）+ usearch HNSW | 离线语义召回 |

## 2. 代码地图

### 2.1 前端

```text
src/features/knowledge/
├── components/
│   ├── knowledge-panel.tsx       # 总装、保存生命周期、项目切换保护
│   ├── knowledge-sidebar.tsx     # Recents、树、仓库、导入入口
│   ├── knowledge-tree.tsx        # 目录构造和虚拟列表
│   ├── knowledge-finder.tsx      # 标题搜索 + 本地语义召回（Ctrl/Cmd+F、Ctrl/Cmd+Alt+F）
│   ├── knowledge-inspector.tsx   # Outline、Backlinks、页面统计
│   ├── knowledge-graph.tsx       # Pixi/Matter 关系图
│   ├── page-properties.tsx       # status/owner/tags/time/reference
│   ├── cover-picker.tsx          # 渐变或本地图片封面
│   ├── icon-picker.tsx           # Emoji 图标
│   ├── editor-topbar.tsx
│   ├── editor-footer.tsx         # 导出入口
│   └── readme-view.tsx           # 挂在知识侧栏中的 repo README 只读页
├── stores/
│   ├── knowledge-store.ts
│   ├── knowledge-meta-store.ts
│   ├── knowledge-links-store.ts
│   └── knowledge-graph-store.ts
└── lib/
    └── cover-url-cache.ts
```

编辑器公共实现位于：

```text
src/features/editor-notion/
├── components/tiptap-editor.tsx
├── lib/extensions.ts
├── lib/blocks-cache.ts
├── lib/outline.ts
└── extensions/mention.tsx
```

### 2.2 Rust

```text
src-tauri/src/commands/
├── knowledge.rs
├── knowledge_meta.rs
├── knowledge_links.rs
├── knowledge_graph_layout.rs
├── knowledge_export.rs
├── mention_search.rs
├── compose_prompt.rs
├── agent_memory.rs
├── memory_indexer.rs
└── memory_retrieve.rs

crates/atlas-kb-server/
├── build.rs
└── src/main.rs
```

Tauri 在 `src-tauri/src/lib.rs` 中注册 `KnowledgeMetaState`、`KnowledgeLinksState` 和全部命令。新增命令时必须同时：声明模块、实现 `#[tauri::command]`、加入 `generate_handler![]`。

## 3. 文件和类型契约

### 3.1 `KnowledgeEntry`

Rust 返回 snake_case JSON：

```ts
interface KnowledgeEntry {
  id: string;          // 相对知识根、无 .md 后缀、使用 /
  title: string;       // 当前 Rust 实现为文件 stem
  content: string;     // Markdown 全文
  source: string;      // note | paper | chat
  file_path: string;   // 实际绝对路径
  updated_at: string;  // 文件 mtime 的 RFC3339
}
```

`source` 仅按文件名启发式产生：`paper-*` 为 `paper`，`chat-*` 为 `chat`，其余为 `note`。

### 3.2 `KnowledgeMetaFile`

```ts
interface KnowledgeMetaFile {
  version: number;
  pages: Record<string, {
    icon?: string;
    cover?: string;
    title?: string;
    /** "paragraph"（默认）| "whole"，控制本地 embedding 分块 */
    chunk_mode?: "paragraph" | "whole";
    status?: string;
    tags?: string[];
    owner?: string;
    created_at?: string;
    updated_at?: string;
  }>;
}
```

前端映射为 camelCase 的 `createdAt` / `updatedAt`。Patch 约定：

- 未传字段：保持现值；
- 字符串/数组：覆盖；
- `null`：清空可空字段；
- `tags: []`：清空 tags。

### 3.3 `KbSource`

```ts
interface KnowledgeSource {
  name: string;  // 顶层 ID 命名空间
  path: string;  // 外部目录绝对路径
}
```

同一路径重复挂载返回已有项。目录名与已有来源或本地知识目录冲突时，追加数字后缀。

### 3.4 链接图

```ts
interface Backlink {
  fromEntryId: string;
  fromTitle: string;
  snippet: string;
}

interface ProjectGraph {
  nodes: Array<{
    id: string;
    title: string;
    inDegree: number;
    outDegree: number;
  }>;
  edges: Array<{ from: string; to: string }>;
}
```

Rust 使用 `#[serde(rename_all = "camelCase")]` 输出图相关结构。`edges` 是用于布局的去重无向投影，`inDegree/outDegree` 仍来自有向关系。

## 4. IPC 命令参考

### 4.1 正文与来源

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `list_knowledge` | `projectPath` | `KnowledgeEntry[]` | 遍历项目与挂载目录，按 mtime 倒序 |
| `save_knowledge_note` | `projectPath,id,content` | 文件路径 | 创建父目录并覆盖 Markdown |
| `delete_knowledge_note` | `projectPath,id` | `void` | 本地硬删；挂载笔记移入 `.trash` |
| `create_knowledge_dir` | `projectPath,dirName` | `void` | 支持在挂载根内创建 |
| `import_into_knowledge` | `projectPath,sources[]` | 导入计数 | 复制，冲突自动改名 |
| `list_knowledge_sources` | `projectPath` | `KbSource[]` | 读取来源配置 |
| `link_knowledge_folder` | `projectPath,path` | `KbSource` | 原地挂载目录 |
| `unlink_knowledge_folder` | `projectPath,name` | `void` | 不删除外部文件 |

所有大部分文件 I/O 命令通过 `tokio::task::spawn_blocking` 执行。

### 4.2 元数据

| 命令 | 说明 |
|---|---|
| `knowledge_meta_load` | 返回当前项目的内存快照；首次从 `_meta.json` 读取 |
| `knowledge_meta_patch` | 应用 patch，返回更新后的单页 meta，计划 300 ms 后写盘 |
| `knowledge_meta_delete` | 从快照删除条目并计划写盘 |

成功写盘后广播：

```json
{
  "event": "atlas:knowledge:meta-changed",
  "payload": { "projectPath": "/project" }
}
```

### 4.3 链接与图

| 命令 | 说明 |
|---|---|
| `knowledge_backlinks` | 查询指向指定 ID 的来源列表 |
| `knowledge_link_counts` | 查询入链/出链计数 |
| `knowledge_links_invalidate` | 删除项目缓存并广播变更事件 |
| `knowledge_links_graph` | 返回全部节点和布局用边 |
| `knowledge_graph_layout_load` | 读取保存的坐标 |
| `knowledge_graph_layout_save` | 临时文件 + rename 写坐标 |

链接失效事件：`atlas:knowledge:links-changed`，payload 同样带 `projectPath`，前端必须过滤，防止多个项目窗口串扰。

### 4.4 封面和网页阅读

| 命令 | 说明 |
|---|---|
| `knowledge_cover_upload` | 复制图片到 `knowledge/covers/`，返回相对路径 |
| `knowledge_cover_data_url` | 最多读取 2 MiB 并返回 data URL；渐变原样返回 |
| `fetch_readable` | 校验公网 HTTP(S)、手动跟随重定向、返回白名单清理后的 HTML |

`cover-url-cache.ts` 按 `projectPath + cover ref` 缓存 data URL，重新上传相同 entry 的封面时必须驱逐旧缓存。

### 4.5 导出

| 命令 | 输出 |
|---|---|
| `knowledge_export_note_md` | 单个 Markdown 文件 |
| `knowledge_export_note_html` | 单个内嵌样式的 HTML；附件和封面不内嵌 |
| `knowledge_export_workspace_md` | 用 `---` 分隔的合并 Markdown |
| `knowledge_export_workspace_html` | `index.html` + 每页平铺 HTML |
| `knowledge_export_server` | 内嵌静态页面的本地 Server 可执行文件 |

### 4.6 本地语义召回

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `knowledge_recall` | `projectPath, query, limit?` | `KnowledgeRecallHit[]` | 用本地 embedding 模型对 KB 做语义召回；缺模型时返回 `model_not_downloaded: <id>` |

`KnowledgeRecallHit` 为 camelCase：`{ entryId, title, snippet, source, score }`。命令每次调用重新扫描 KB，索引写入 `<project>/.atlas/knowledge-index/`，与 Agent 记忆索引分离；query 少于 2 字符直接返回空。

## 5. 前端状态与生命周期

### 5.1 `knowledge-store`

状态字段：

- `entries`、`sources`：Rust 返回的当前项目镜像；
- `activeEntryId`：当前笔记；
- `editContent`：切换条目时提供给编辑器的 Markdown；
- `pendingOpenId`：面板未挂载时，由外部请求打开的笔记；
- `loading`：加载状态。

`loadEntries` 并行调用条目和来源命令。如果 ID 与 `updated_at` 都未变化则避免重渲染；当前条目不存在时选择第一项。加载后异步发布 mention cache。

注意：错误大多被静默吞掉。调用者如果需要可靠用户反馈，应在 action 契约改为返回错误后再统一处理，不要继续在多个组件各写一套 toast。

### 5.2 `knowledge-meta-store`

- 每次只绑定一个项目；
- 对 patch 先乐观合并；
- Rust 调用失败则恢复旧 `pages`；
- 收到 meta event 后重新 hydrate；
- 标题或图标变化后重新发布 mention cache；
- `chunkMode`（`paragraph` / `whole`）随 patch 一起写入 `_meta.json` 的 `chunk_mode`，缺省视为 `paragraph`。

Store 使用模块级 `unlisten`，这表示它是单绑定实例，不适合在同一 webview 内同时挂两个不同项目的 KnowledgePanel。

### 5.3 `knowledge-links-store` 与 `knowledge-graph-store`

links store 不保存 backlink 列表，只维护 `rev`。事件到达时 `rev + 1`，各 hook 重新调用 Rust。graph store 保存整个 `ProjectGraph`，事件到达时重新拉取。

### 5.4 面板常驻与工作区切换

Knowledge 面板会在 tab 切换时保持挂载。工作区切换不能依赖组件卸载来保存，因此 `KnowledgePanel` 向 `flush-registry` 注册 `knowledge` flush。该回调使用切换上下文的 `ctx.path` 保存离开的项目，而不是可能已经变化的 React `currentProject`。

## 6. 编辑器实现

### 6.1 扩展栈

`buildExtensions()` 当前包含：

- StarterKit（关闭默认 code block、link 和 Bold 快捷键）；
- 自定义 Bold；
- lowlight 代码块；
- task list/item；
- link、placeholder、typography、highlight；
- 可缩放 table；
- `tiptap-markdown`；
- slash menu；
- Callout、Toggle；
- Atlas mention。

### 6.2 dirty 与 flush

`dirtyRef` 是是否需要保存的权威标志；React 的 `isDirty` 只负责显示。`flush()` 从 `editor.storage.markdown.getMarkdown()` 获取 Markdown，缓存 JSON 并清除 dirty。

切换文档时：

1. 保存当前 JSON 到模块级 cache；
2. 优先恢复目标 JSON；
3. 否则解析 `initialMarkdown`；
4. 把裸 `@(knowledge|note|page):id` 重新包装为原子 mention node；
5. 标记新文档为 clean。

cache key 使用 `note:<entryId>`；项目变化时必须调用 `clearDocCache()`，因为不同项目可能有同名 ID。

### 6.3 mention 序列化

编辑器中 mention 是原子 node，保存 Markdown 时序列化为：

```text
@<kind>:<id>
```

加载时 Tiptap Markdown 不会自动还原这个 node，因此 `rehydrateMentions()` 扫描文本并反向替换。当前正则仅支持 `knowledge|note|page`，ID 字符范围为 `\w`, `-`, `.`, `/`。

## 7. 链接引擎实现

`build_graph` 每次缓存失效后全量遍历所有 Markdown：

1. 读取 `(id, filename-title, body)`；
2. 扫描 `[[id]]`；
3. 扫描三个 `@kind:id` 形式；
4. 兼容旧 HTML mention span；
5. 忽略自引用；
6. 对同一来源的 target 去重；
7. 为 backlink 生成约匹配点前后 90 字节的单行 snippet。

实现是 O(笔记总正文长度)，缓存后查询为 HashMap 读取。当前规模下比维护增量数据库简单；只有实际扫描耗时成为问题时才值得改为按文件增量更新。

外部工具直接改文件不会主动失效缓存。新增 watcher 时应复用一个统一的“knowledge changed”入口，同时触发 entries、links、mention 和 RAG，而不是分别添加四套 watcher。

## 8. mention 与 Agent prompt

### 8.1 搜索缓存

`publishKnowledgeToMentionCache()` 推送：

```ts
{
  id,
  title: meta.title || entry.title,
  icon: meta.icon || null,
  source,
  filePath
}
```

Rust `MentionCacheState` 按 `workspaceId`，否则按 webview label 隔离。空 query 返回前 30 条；有 query 时使用 nucleo 对 `title + folder` 打分。

### 8.2 prompt 组合

知识 mention 不作为 ACP `ResourceLink` 发送，而是内联正文，因为它属于语义上下文。格式：

```md
用户原始问题

---
# Atlas context

## @note:<id>

<最多约 32 KiB 的 Markdown 正文>
```

前端 store 中有正文时直接传 `inlineBody`，否则 Rust 从 `filePath` 读取。多个 mention 按 ID 保留第一次并去重。

每篇知识正文独立限制为约 32 KiB；当前没有全部知识 mention 的总字符预算。前端先完成显式 mention 组合，再调用 Agent send，因此 Rust 发送链以“用户文本 + `Atlas context`”作为自动 RAG query。普通 turn 最终按以下顺序组合：

1. `SHARED MEMORY` 工作记忆；
2. `RELEVANT PROJECT MEMORY` 语义召回；
3. 首轮 bootstrap（仅该会话第一次普通发送）；
4. 用户文本及显式 `@note` 上下文。

Slash command 为保持 `/command` 位于 byte 0，不执行上述记忆注入。

## 9. RAG 集成

### 9.1 语料映射

`agent_memory::collect_corpus()` 调用 `read_knowledge_docs()`，后者复用 `list_knowledge_sync()`。Markdown 笔记使用原正文；其他文件先由 `knowledge_convert` 调用 Rust `markitdown = 0.1.11` 转成 Markdown，再进入相同的 `MemoryDoc` 和 embedding 流程。转换在 `spawn_blocking` 后台线程执行，无需 Python 或 Node.js。

转换结果保存在项目 `.atlas/cache/knowledge-markdown/`，缓存按原文件路径隔离，并按修改时间、大小和转换器版本失效。原文件不会被覆盖，目录和预览仍指向原文件；缓存不会作为额外笔记显示。损坏的缓存自动重新转换。解析失败、不支持、空结果或超过 64 MiB 的文件回退到文件名索引，单个失败不会中断其余文件。正文最多保留 200 万字符。

支持范围以 Rust 库为准，包括 PDF、DOCX、XLSX、PPTX、HTML、CSV 等；TXT/JSON/YAML 等 UTF-8 文本可直接作为 Markdown 文本使用。图片只提取库支持的元数据，不启用 LLM 或 OCR。每个有效条目由 `to_corpus_doc()` 转成：

```rust
CorpusDoc {
    id: "kb:<entry-id>",
    text: "<title>\n\n<markdown>",
    content_hash: sha256(text),
    corpus: "note",
}
```

内容哈希让未改变的条目不重新 embedding，已删除 ID 会从索引删除。embedding 模型 ID 或维度变化时整库 reset 后重建。

本地召回默认按 Markdown 空行段落分块（`ChunkMode::Paragraph`）：小段合并到约 400 字符，长段按中英文句末切分，相邻块保留约 48 字符 overlap；chunk id 由 `<entry-id>#<内容哈希>` 生成，内容相同则追加序号，保证增量 embedding 稳定。可在页面属性把单条笔记切到 `whole`（整篇一个向量），选择记录在 `_meta.json` 的 `chunk_mode` 字段。

### 9.2 触发和锁

首次 `MemoryRegistry::engine_for(cwd)`：

- 打开/迁移索引；
- 启动文件 watcher；
- enqueue 首次 `IndexCorpus`；
- enqueue 空闲整理。

索引在单后台任务里串行处理，并持有项目 engine 写锁。检索只尝试读锁；拿不到即跳过，避免 Agent send 因重建被卡住。

当前 watcher 没有覆盖知识目录和挂载来源，知识保存也没有 enqueue index。这是已确认的集成缺口；不要在文档或 UI 中承诺“保存后立即可语义检索”。

Agent 运行结束时，`agents.rs` 的 `TurnFinished` 分支会调用 `MemoryRegistry::enqueue_index(cwd)`，所以已保存笔记会在下一次 Agent turn **完成后**随全语料扫描进入索引。这里不是“每次发消息前重建”，队列满时该 nudge 还可能被丢弃。

可手动请求重建的 Tauri 命令是：

```ts
await invoke("force_reindex", { cwd: projectPath });
```

现有前端封装位于 `src/features/settings/lib/models-api.ts` 的 `models.reindex(cwd)`。命令只负责打开 engine 并把 `IndexCorpus` 放入后台队列，返回成功不等于 embedding 已经完成；实际结果应结合 `atlas::memory_indexer` 日志判断。

默认 embedding 模型是 `bge-small-zh-v1.5`（约 97 MB、512 维，中文检索）。用户入口是 **Settings → Local Models**，选择模型后点击下载并设为当前模型。开发时可以执行：

```ts
const list = await invoke<Array<{ id: string; downloaded: boolean; selected: boolean }>>(
  "models_list",
);
await invoke("model_download", { id: "bge-small-zh-v1.5" });
```

`model_download` 同样只启动后台下载，应监听 `atlas:model-download:done`。模型保存在 Tauri `app_data_dir()/models/<model-id>/`；当前 embedding 模型至少需要 `config.json`、`tokenizer.json` 和 `model.safetensors`。`memory_embed_status` 可返回当前模型 ID、实际目录和 `downloaded` 状态。

### 9.3 检索

- query 少于 4 字符直接返回空；
- HNSW cosine 低于 0.30 的候选丢弃；
- embedding 权重 1.0、图权重 0.1、稀疏时全局图权重 0.05；
- RRF 常数 60；
- Jaccard ≥ 0.8 的后续片段视为重复；
- 自动注入最多约 1400 字符，每条最多 320 字符；
- 整个检索最多 6 秒。

以上权重适用于 Agent 记忆检索（graph + embedding 混合）。知识库的 `knowledge_recall` 走独立路径：索引放在 `<project>/.atlas/knowledge-index/`，只调用 `retrieve_embeddings`（纯 embedding，不混 graph/global），每次调用重新扫描 KB 并做 chunk 级增量 embedding，阈值和去重规则同上；同一笔记的多个 chunk 在返回前按 `entryId` 聚合成最佳一条。标题搜索不依赖模型，模型缺失时语义模式返回 `model_not_downloaded: <id>` 并引导到 Settings → Local Models 下载。

## 10. 导出实现细节

### 10.1 Markdown 与 HTML

`walk_notes()` 复用知识根遍历，因此包括挂载笔记。工作区 Markdown 按标题小写排序，每篇加一级标题并用水平线分隔。

HTML 工作区当前把所有页面平铺到目标目录：

```text
target/
├── index.html
├── folder__note-a.html
└── note-b.html
```

`slugify` 只把 `/` 替换成 `__`。导航使用相同平铺地址。

### 10.2 独立 Server

流程：

1. 在临时目录渲染 HTML；
2. 设置 `ATLAS_KB_WEB=<temp>`；
3. 执行 `cargo build --release --manifest-path crates/atlas-kb-server/Cargo.toml`；
4. `build.rs` 把页面复制到 `OUT_DIR/web`；
5. `include_dir!` 编译进二进制；
6. 把二进制复制到用户目标路径并删除临时网页目录。

Server 只绑定 loopback，不提供鉴权、写入或远程访问。

## 11. 安全检查清单

修改知识库时至少保持以下不变量：

- 所有 renderer 提供的知识路径必须经过 `kb_rel` 或等价的组件级校验；
- 不能通过 trim 把绝对路径“变成”相对路径；
- 链接来源路径不允许由 ID 逃逸；
- 外部目录删除必须保持可恢复，不可改成本地同样的硬删除；
- 任意 URL 抓取的每次重定向都要重新做 SSRF 地址检查；
- 任何进入主 webview 的 HTML 必须白名单清理；
- IPC 返回 data URL 前必须限制原始文件大小；
- Agent 自动注入内容必须继续做长度限制和 secret redaction；
- 多项目事件必须按 `projectPath` 过滤。

## 12. 开发与验证

### 12.1 推荐的最小检查

首次开发环境需要 Bun 1.4.0（`mise.toml` 和 `package.json` 已固定）、Node LTS 和 Rust stable。平台原生依赖：

- macOS：Xcode Command Line Tools；
- Windows：Visual Studio Build Tools，安装 C++ workload；
- Linux：GTK 3、WebKit2GTK 4.1 和 GLib 开发头文件；具体包名因发行版不同。

从干净 clone 首次启动：

```powershell
bun install
bun run dev:app
```

`bun run dev` 只启动 Vite，所有 `invoke()` 都需要 `bun run dev:app` 的 Tauri shell。Claude Code Agent 还要求 `claude` CLI 位于 `PATH`；Atlas 原生 Agent 不需要额外 CLI。API key、`.env` 和账号都不是本地构建必需项。

```powershell
bun run typecheck:app
bun run test
cargo test --manifest-path src-tauri/Cargo.toml commands::knowledge
git diff --check
```

Rust 全量测试在仓库脚本中使用 Bash：

```bash
bun run test:rust
```

`atlas-kb-server` 是运行时按需编译的模板 crate，仓库的 `scripts/test-rust.sh` 明确不覆盖它。修改 Server 时需要单独构建或实际执行一次 `knowledge_export_server` 流程。

Rust 日志同时写 stderr 和每日滚动文件。默认日志目录：

- macOS：`~/Library/Logs/dev.atlas.ide/`；
- Windows/Linux：系统 local data 目录下的 `dev.atlas.ide/logs/`。

调试运行可设置：

```powershell
$env:RUST_LOG='atlas=debug,tauri=debug'
bun run dev:app
```

索引成功的正常基线包含 `atlas::memory_indexer` 的 `indexed <cwd>: +N ~N -N =N` 日志。知识文件读写错误当前不都写日志或 toast；排障时同时检查文件权限和命令返回值。

### 12.2 建议补充的回归用例

1. 本地和挂载笔记的读取、保存、删除语义；
2. `.md` / `.markdown` 导入一致性；
3. meta 的 set/clear/omit 和磁盘重载；
4. meta 标题在列表、backlink、graph、mention、export、RAG 中一致；
5. 新建、导入、外部编辑后图缓存刷新；
6. 知识保存后 memory index 增删更新；
7. HTML 导出拒绝或清理脚本；
8. 工作区切换期间 dirty note 不串项目；
9. 读取失败时 UI 显示错误而不是保留伪成功状态。

## 13. 排障

### 笔记不出现在侧栏

检查：

1. 文件扩展名是否为小写 `.md`；
2. 文件或其父目录是否以 `.` 开头；
3. 挂载是否存在于 `.atlas/knowledge-sources.json`；
4. 外部目录路径是否仍存在；
5. 手动重新加载是否恢复。

当前遍历严格判断扩展名等于 `md`，大写 `.MD` 和 `.markdown` 不会出现。

### 标题在不同位置不一致

检查 `.atlas/knowledge/_meta.json` 的 `pages[id].title`。侧栏和图会在前端覆盖文件名标题，但 backlink、RAG 和当前导出路径不都使用该覆盖。这是现有缺口，不是缓存清理一定能解决的问题。

### backlink 或图未刷新

确认保存路径最终调用了 `knowledge_links_invalidate`。后端保存命令本身不会自动失效链接缓存；导入、新建和外部编辑尤其容易漏掉。

外部程序改写 Markdown 后，当前没有一个用户操作能保证四条派生链一次恢复。开发调试时按以下顺序执行：

```ts
await useKnowledgeStore.getState().actions.loadEntries(projectPath); // 条目 + mention cache
await useKnowledgeMetaStore.getState().actions.bind(projectPath);   // 重新读取 _meta.json
await invoke("knowledge_links_invalidate", { projectPath });        // backlinks + graph
await models.reindex(projectPath);                                   // RAG，异步入队
```

其中 mention cache 由 `loadEntries` 的动态发布更新；若调用方要求搜索立即可用，应再显式 `await publishKnowledgeToMentionCache()`。普通用户只能重启应用以重载条目/元数据/链接缓存，再到 Settings → Local Models 切换模型或由开发入口请求 reindex；当前 UI 没有“刷新全部知识派生数据”按钮。

### `@note` 搜不到

确认：

1. `list_knowledge` 能返回条目；
2. `publishKnowledgeToMentionCache` 已执行；
3. cache 使用的 `workspaceId` 与搜索相同；
4. 搜索的是标题或目录，不是正文。

### Agent 语义检索不到刚保存的笔记

这是当前触发链缺口。先用显式 `@note`；在 Settings → Local Models 确认当前模型已下载，开发调试时调用 `models.reindex(projectPath)`，或直接 `invoke("force_reindex", { cwd: projectPath })`。命令入队后查看 `atlas::memory_indexer` 日志确认完成；不要仅通过继续编辑笔记期待 watcher 触发。

### 封面不显示

检查文件是否仍位于 `.atlas/knowledge/` 下、是否超过 2 MiB，以及 `cover-url-cache` 是否持有同 ref 的旧 data URL。上传覆盖后应调用 `evictCoverUrl`。

### Server 导出失败

检查：

- `cargo` 是否在 `PATH`；
- `crates/atlas-kb-server/Cargo.toml` 是否存在；
- 临时目录是否可写；
- cargo stderr；
- 目标文件是否可写。

## 14. 修改指南

### 新增页面属性

最少需要同步修改：

1. Rust `PageMeta`；
2. Rust `PageMetaPatch` 和 `apply`；
3. TS `RustPageMeta`、`PageMeta`、`PageMetaPatch`；
4. `fromRust`、乐观 merge、`toRustPatch`；
5. 属性 UI；
6. set/clear/omit 测试。

不要把单页属性另建数据库；现有 `_meta.json` 足够，除非有已测量的并发或规模问题。

### 新增引用语法

同时修改：

1. Tiptap serializer；
2. Tiptap rehydrate；
3. Rust `find_refs`；
4. mention 搜索/显示（若有新 kind）；
5. prompt 组合（若应传给 Agent）；
6. 解析和 snippet 测试。

### 新增知识来源

优先让新来源最终映射为稳定的 `(id, path, content, mtime)`。必须明确：

- 是复制还是原地挂载；
- ID 命名空间如何避免冲突；
- 删除是否可恢复；
- 文件变化如何使 entries、links、mention 和 RAG 同时失效；
- 导出是否包含该来源。

## 15. 当前实现定位

- CRUD 与安全：`src-tauri/src/commands/knowledge.rs:24`、`:183`、`:201`
- 元数据：`src-tauri/src/commands/knowledge_meta.rs:65`、`:274`
- 链接：`src-tauri/src/commands/knowledge_links.rs:103`、`:156`
- 图：`src/features/knowledge/components/knowledge-graph.tsx`
- 保存边界：`src/features/knowledge/components/knowledge-panel.tsx:180`
- 编辑器：`src/features/editor-notion/components/tiptap-editor.tsx`
- prompt：`src-tauri/src/commands/compose_prompt.rs:214`、`:337`
- RAG 语料：`src-tauri/src/commands/agent_memory.rs:388`
- 索引触发：`src-tauri/src/commands/memory_indexer.rs:237`、`:430`
- 导出：`src-tauri/src/commands/knowledge_export.rs:97`
