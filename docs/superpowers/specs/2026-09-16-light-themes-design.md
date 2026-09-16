# 亮色主题设计

- 日期：2026-09-16
- 状态：设计已确认，待实现计划
- 范围：界面主题（Interface Theme）+ 编辑器主题（Editor Theme）

## 目标

为 Atlas 增加完整的亮色主题能力，质量标准为「可交付、可向上游提 PR」。

**硬性约束：暗色模式像素级不变。** 现有 6 个界面主题、10 个编辑器主题在改造前后外观必须完全一致。这是改动能被上游接受的前提，并由测试强制（见「测试」第 1 条）。

## 已确认的决策

| 问题 | 决定 |
|---|---|
| 质量标准 | 完整能力，非「先凑合能用」 |
| 产品形态 | 先选模式（Light / Dark / System），再选该模式下的主题 |
| 编辑器主题 | 与界面共用同一个模式，两边一起按模式过滤 |
| 首发主题 | 官方孪生版共 6 个（界面 3 + 编辑器 3） |
| 改造手段 | 引入单一前景叠加色 `contrast`，机械替换写死颜色 |

## 非目标

- 让暗色主题也能改变终端颜色。今天 Chyral 等主题下终端仍是 `#000`，改变它会改动现有外观，违背硬性约束。留作后续。
- 为没有官方亮色版的暗色主题（Chyral、Mirage、Phosphor、Vesper 等）设计亮色孪生。
- 截图回归测试基础设施。仓库测试注释明确说明没有截图设施，视觉验证在评审时人工完成。

---

## 一、模式层与存储

### 存储

Rust `AppSettings`（`src-tauri/src/state/atlas_config.rs`，落盘到 `config.toml`）新增 3 个字段，**不改名任何现有字段**：

| 字段 | 类型 | serde 默认值 |
|---|---|---|
| `theme_mode` | 枚举 `Light` / `Dark` / `System` | `Dark` |
| `atlas_theme_light` | `String` | `"atlas-light"` |
| `code_editor_theme_light` | `String` | `"atlas-light"` |

现有 `atlas_theme` / `code_editor_theme` 保持原义，即**暗色模式下的选择**。无迁移：旧 `config.toml` 原样加载，外观不变。

每个新字段都要照 `atlas_theme` 的现有模式接入：结构体字段、默认函数、`Default` 实现、patch 结构体、patch 应用、TOML 写回、`validate`（非空校验）。

**按模式分别记住选择是必需的。** System 模式会随系统外观自动翻转，必须落到用户为该模式选定的主题上；单一槽位会导致翻转时重置为默认，或把暗色调色板铺在亮色底上。

**默认 `Dark` 的理由：** 升级不得改变任何用户的外观。默认 `System` 会让系统为亮色的用户升级后突然看到亮色 Atlas。

### 主题目录

- 界面主题 `AtlasTheme` 新增字段 `mode: "light" | "dark"`。
- 编辑器主题**复用已有的** `dark: boolean`（`src/features/editor/themes/types.ts`），不新增第二个字段。

### 解析

单一前端函数负责：

1. 计算实际模式：`themeMode === "system"` 时读 `matchMedia("(prefers-color-scheme: dark)")`，否则取 `themeMode`。
2. 在 `<html>` 上设置 `data-mode` 属性，并通过 **`document.documentElement.style.colorScheme`** 设置 `color-scheme`（使原生滚动条与表单控件随模式变化）。
3. 从该模式的槽位应用界面主题。
4. 从该模式的槽位应用编辑器主题。
5. 将 `themeMode` 写入启动缓存（见第二节「启动闪屏」）。

System 模式下订阅 `matchMedia` 的 `change` 事件并重新解析；离开 System 模式时移除监听。

已核实：

- `tauri.conf.json` 未为窗口固定主题，代码中无 `set_theme` 调用，WebView 跟随系统外观，`prefers-color-scheme` 可用。
- `index.html` 当前在三处声明暗色：`<html style="…color-scheme:dark">` 内联样式、`<meta name="color-scheme" content="dark">`、内联 `<style>` 中的 `html, body, #root { color-scheme: dark; }`。当前生效方案即为暗色，故暗色模式保持 `dark` 即像素级不变；亮色模式必须显式切到 `light`，否则 6 处原生控件与滚动条在亮色 UI 上仍为暗色。

**`color-scheme` 为何不放进 CSS 层而由 JS 设置：** `<html>` 上的内联样式优先级高于任何样式表规则，`:root[data-mode="light"] { color-scheme: light }` 不会生效。JS 写 `style.colorScheme` 直接覆盖同一内联属性。

**`body` 与 `#root` 的声明须移除：** 它们各自声明了 `color-scheme: dark`，会阻断从 `<html>` 的继承，只改 `<html>` 时这两者及其后代仍为暗色。将 `index.html` 中该规则的 `color-scheme` 仅保留在 `html` 上；`body`、`#root` 改为继承，暗色下结果不变。

**脏数据兜底：** 槽位中的 id 不存在或属于另一模式（例如手改 TOML）时，回退到该模式的基础主题，而不是渲染模式不符的调色板。

### 选择器 UI

- 在 Appearance 头部行（`settings-panel.tsx`，左侧两个标签页、右侧缩放控件）中间加入 **Light / Dark / System 分段控件**。它同时作用于两个标签页，因此置于标签之上。
- 主题网格按实际模式过滤。
- System 模式下网格分为「Light」「Dark」两段，无需切换系统外观即可设置两个槽位。

---

## 二、颜色改造

### 三层级联

| 层 | 选择器 | 内容 |
|---|---|---|
| 1. 暗色底 | `:root` | 不改动任何现有值 |
| 2. 亮色底（新增） | `:root[data-mode="light"]` | Atlas Light 完整调色板、主题未覆盖 token 的亮色值（`color-scheme` 不在此层，见第一节） |
| 3. 主题覆盖 | `applyAtlasTheme` 写入的内联变量 | 各主题调色板 |

使用 `:root[data-mode="light"]`（特异性 0,2,0）而非 `[data-mode="light"]`（0,1,0，与 `:root` 同级，胜负取决于声明顺序，脆弱）。

**基础主题清空覆盖：** Atlas Black 目前在应用时清空全部内联覆盖以直接使用 `:root`。Atlas Light 同理直接使用第 2 层。`apply-atlas-theme.ts` 中的 `theme.id === DEFAULT_ATLAS_THEME_ID` 判断推广为「是否为某一模式的基础主题」。

### 新颜色 `contrast`

- `:root`：`--contrast: #ffffff`
- `:root[data-mode="light"]`：`--contrast: #000000`
- `globals.css` 的 `@theme inline` 增加：`--color-contrast: var(--contrast);`

`contrast` **独立于主题文字色**，不复用已有的 `--color-foreground`。原因：非默认暗色主题（如 Chyral）可能将前景色调为暖白，复用会给这些主题的叠加色染色，破坏暗色像素级不变。所有暗色主题下 `--contrast` 恒为纯白，所有亮色主题下恒为纯黑；**不提供逐主题覆盖**，`ThemeSpec` 不新增此字段。

已核实无命名冲突：代码中不存在 `--contrast` / `--color-contrast`，也无 `contrast-*` 滤镜类的使用。

同一透明度在亮色下效果合理，例如 `border-contrast/10` 为 10% 黑，约 `#e6e6e6` 的发丝线。

### 写死颜色的改造规则

UI 中现有约 294 处带透明度的白色叠加与 16 处无透明度的白色，约 98 处黑色叠加。规则的依据是**颜色画在什么上面**，而非类名本身：

| 形态 | 约数 | 处理 |
|---|---|---|
| `border-white/N`、`bg-white/N`、`hover:bg-white/N` 及 ring / divide / 渐变 | 202 | codemod 替换为 `*-contrast/N`，透明度原样保留 |
| CSS 与内联样式中的 `rgba(255,255,255,a)` | 85 | 替换为 `color-mix(in srgb, var(--contrast) a%, transparent)` |
| `text-white/N`、无透明度的 `text-white` / `bg-white` | 7 + 16 | 人工分拣：位于彩色填充上（头像、accent 按钮、便利贴）保留；位于主题底色上改为文字 token |
| `Dialog.Overlay` 等遮罩上的 `bg-black/N` | 39 | 保留，遮罩在两种模式下均为暗色 |
| `rgba(0,0,0,a)` | 56 | 阴影收进 `--shadow-*` token；遮罩保留 |
| `border-black/N`、`text-black/N` | 3 | 人工分拣 |

分拣依据来自抽样：`text-white/N` 多见于 `account-avatar.tsx`、`comms-avatar.tsx`、`note-node.tsx` 的彩色填充之上；`bg-black/60` 集中于 `Dialog.Overlay`。

**为何用 `color-mix` 而非相对颜色语法** `rgb(from var(--contrast) r g b / a)`：Tailwind v4 本身已输出 `color-mix`，应用早已依赖其兼容下限，不引入新门槛；相对颜色语法需要 Safari 16.4+，而 `.cargo/config.toml` 声明的最低系统是 macOS 11，会抬高下限。`color-mix(in srgb, #fff 10%, transparent)` 与 `rgba(255,255,255,0.1)` 结果相同。

### 主题未覆盖 token 的亮色值

以下 token 不在 `ThemeSpec` 中，暗色值在亮底上不可用，需在第 2 层提供亮色值：

| token | 暗色现值 | 问题 |
|---|---|---|
| `--shadow-sm/md/lg/overlay` | `rgba(0,0,0,0.6 ~ 0.95)` | 亮底上呈污渍状，强度需降至约 0.1 |
| `--comms-surface` / `--comms-outer` | `#000000` / `#0f0f0f` | 团队聊天面板在亮色下仍为纯黑 |
| `--comms-mention-bg` 等 | `rgba(255,255,255,…)` | 亮底上不可见 |
| `--stat-added` / `--stat-removed` | `#3fb950` / `#f85149` | GitHub 暗色配色，白底对比不足 |
| `--diff-*-text` | `#3fb950` 等 | 同上 |
| `--status-warning` | `#cd9731` | 白底约 2.5:1，不达标 |
| `--accent-primary-muted` | `rgba(255,255,255,0.06)` | 亮底上不可见 |

### JS 渲染的表面

CSS 变量无法作用于 canvas / WebGL 与 JS 配置的渲染器。

- 将 `mermaid-block.tsx` 中现有的 `cssVar()` 提升为共享的 `readToken()`。mermaid 已按正确模式实现（渲染时读取实时 token），作为范例。
- `applyAtlasTheme` 结束时派发 `atlas:theme-changed` 事件，与 `App.tsx` 中已有的 `atlas:app-ready` 事件采用同一模式。各渲染器监听后重新读取 token。

| 渲染器 | 位置 | 写死颜色数 | 处理 |
|---|---|---|---|
| xterm 终端 | `terminal-session.ts:97` | 19（背景、前景、光标、选区 + 16 ANSI） | 读 token；ANSI 16 色需要亮色版（ANSI 黄、白在白底不可见），作为 `--term-*` 放入第 2 层 |
| recharts | `mission-control/lib/chart-theme.ts` | 常量（注释标明所模仿的 token） | 渲染时读 token |
| pixi 知识图谱 | `knowledge-graph.tsx` | 11 | 读 token，收到事件重绘 |
| pixi 记忆图谱 | `memory-graph-canvas.tsx` | 15 | 读 token，收到事件重绘 |

**暗色不变的边界：** 暗色 `:root` 中每个新增 token 的值都等于其所替换的现有字面量。因此 Chyral 下终端仍为 `#000`，与现状一致。

### 启动闪屏

`index.html` 的启动骨架屏 `.atlas-boot` 写死暗色（`background: #050505`，文字 `rgba(255,255,255,0.3)`），在 React 首次渲染前显示。设置存于 `config.toml`，经 Rust 异步 IPC 才能读取，HTML 解析时不可得。若不处理，亮色用户每次冷启动都会先闪黑屏再变白。现状下 Chyral 等暗色主题也会从 `#050505` 切到主题底色，但暗到暗不明显；黑到白是明显缺陷。

当前不存在挂载前的主题缓存。方案：

- **缓存：** 每次应用主题时（第一节解析步骤 5）将 `themeMode`（`light` / `dark` / `system`）写入 `localStorage`。只缓存模式，不缓存颜色。
- **启动脚本：** `index.html` 的 `<head>` 中加入一段内联脚本，在骨架屏绘制前读取缓存；`system` 时用 `matchMedia` 解析；随后设置 `data-mode` 与 `style.colorScheme`。
- **骨架屏亮色变体：** 为 `.atlas-boot` 增加 `:root[data-mode="light"]` 下的样式，颜色取 Atlas Light 中性色。使用 One Light、Rosé Pine Dawn 的用户会看到从白到米色的轻微切换，与现状暗色主题的 `#050505` → 主题底色属同一类，可接受。
- **缓存仅作加速：** `config.toml` 仍是唯一真实来源。缓存缺失、损坏或读取抛错时按暗色处理（即现状）；外部改动 `config.toml` 导致缓存过期时，只影响一次启动，主题应用后自动纠正。

**CSP：** `index.html` 的注释记录了内联 `<style>` 在打包构建中的 CSP 故障史。`tauri.conf.json` 仅对 `style-src` 关闭了 Tauri 的资源 CSP 改写，内联脚本在打包构建中会被加 nonce 并放行。**开发模式从不触发 CSP 改写**（注释原文说明 Vite 提供的文件不会被加 nonce），因此启动脚本必须在**打包构建**中验证。

---

## 三、配色来源

### 原则：两个目录各守现有约定

| 目录 | 现有暗色约定（证据） | 亮色孪生做法 |
|---|---|---|
| 编辑器主题 | 官方调色板原样照搬，按「语法角色 → 色名」映射。例：Catppuccin Mocha 的 `bg #1e1e2e`（base）、`keyword #cba6f7`（mauve）、`string #a6e3a1`（green）、`func #89b4fa`（blue） | 同一套角色→色名映射，换成亮色版官方值 |
| 界面主题 | 官方色相 + Atlas 深度阶梯。文字与强调色取官方值，表面色为 OLED 压暗。例：Rosé Pine 官方底色 `#191724` 压到 `#08070a`；One Dark 官方底色 `#282c34` 用作边框色 | 文字与强调色取官方值；表面色映射到 Atlas 阶梯角色，**不再压色**（压暗是为 OLED，亮色无此理由） |

**亮色阶梯方向不同于暗色。** 暗色为「层级越高越亮」。亮色为：base 取官方底色，panel / 侧栏略深，popover / 浮层最亮，层次由第二节的亮色阴影 token 拉开。

### 逐个主题

| 主题 | 界面 | 编辑器 | 来源 |
|---|---|---|---|
| One Light | 有 | 有 | Atom 官方 `one-light-ui` / `one-light-syntax` |
| Rosé Pine Dawn | 有 | 无 | `rose-pine/palette` 官方 Dawn 变体 |
| Catppuccin Latte | 无 | 有 | `catppuccin/palette` 官方 Latte，与 Mocha 同名映射 |
| Atlas Light | 有 | 有 | 无官方来源，按下述规则自行设计 |

此形状与暗色目录对应：暗色中 Rosé Pine 仅有界面版，Catppuccin 仅有编辑器版。

### Atlas Light 的设计规则

- **界面：** Atlas Black 为纯中性灰阶、白色强调。Atlas Light 为纯中性灰阶反转、黑色强调，零色度。
- **编辑器语法色：** 每个角色保留暗色 Atlas 编辑器主题的**色相**，仅降低明度，直至在亮底上达到 WCAG AA 4.5:1。
- **招牌黄的取舍：** 暗色 Atlas 的 `func: #ffff00`（描述为「the Atlas yellow accent」）在白底上约 1.07:1，无法原样沿用。按上条规则，它落到暗金色系：色相仍属 Atlas 黄，但可读。

### 硬性要求

1. **官方色值必须从上游仓库获取，不得凭记忆填写**，并在代码注释中注明出处。
2. 对比度阈值沿用仓库现有规则（`themes.test.ts`）：
   - Atlas 自研主题（`ATLAS_AUTHORED`）语法色 ≥ `AA_TEXT`（4.5:1）。
   - 移植的第三方调色板语法色 ≥ `FLOOR`（3:1）。仓库注释说明：保留官方外观，但底线保证不引入不可读的颜色。

---

## 四、测试

### 必须修改的现有测试

`src/features/editor/themes/themes.test.ts`：

- **对比度矩阵按模式配对。** 现为「每个编辑器主题 × 每个界面底色」（`INTERFACE_BASES` 取自全部 `ATLAS_THEMES`）。加入亮色后若不改，所有暗色编辑器主题会与白底比较，CI 必然失败。改为「× 同模式的界面底色」，条件为 `theme.dark === (base.mode === "dark")`。这正是 UI 强制的规则；`INTERFACE_BASES` 的注释已预见「a new interface theme with a lighter base」。
- `ATLAS_AUTHORED` 加入 `"atlas-light"`。
- 「the default theme」一组写死了 `#000000` 底色与 `func === "#ffff00"`：暗色部分原样保留；为 Atlas Light 新增平行一组——注释低调但 ≥ AA、行号可见、语法家族可区分、`func` 色相位于黄色区间（检查色相范围，不检查精确 hex）。

### 新增测试

1. **暗色金标快照。** 在修改任何代码之前，将 `tokens.css` 中 `:root` 每个自定义属性的当前值存为快照并提交；测试断言 `:root` 值与快照一致。新增暗色 token 仅允许出现在白名单中，并注明其替换的字面量。此项将「暗色像素级不变」从承诺变为 CI 强制的事实。
2. **写死颜色守卫。** 扫描 `src/**/*.{ts,tsx,css}` 中的白色叠加，白名单外出现即失败。白名单按「文件 + 代码片段 + 理由」登记，不使用行号。`:root` 块豁免。
3. **模式解析**（happy-dom，mock `matchMedia`）：显式模式忽略系统；System 跟随系统；系统切换仅在 System 模式下触发重新应用；离开 System 模式时移除监听；失效或模式不符的 id 回退到该模式基础主题。
4. **级联与应用器：** 亮色模式设置 `data-mode` 与 `style.colorScheme`；两个基础主题均清空内联覆盖；亮→暗切换后无残留亮色内联变量；每次应用恰好派发一次 `atlas:theme-changed`；每次应用将 `themeMode` 写入启动缓存；`localStorage` 抛错时应用流程不中断。
5. **目录完整性：** 每个界面主题都有 `mode`；每个模式恰好一个基础主题；默认值存在；id 唯一；所有主题主文字色 ≥ 4.5:1。
6. **Rust**（`atlas_config.rs`，由 macOS CI 的 `cargo test --locked` 执行）：不含新字段的旧 `config.toml` 加载为 `Dark`、亮色槽位取默认值、`atlas_theme` 不变；TOML 写回包含新字段；patch 可修改 `theme_mode`；非法模式值被拒绝。

### 一次性核验（不入库）

改造前后各构建一次 CSS 并 diff，确认暗色下 `bg-white/10` 与 `bg-contrast/10` 产出相同声明。这是「暗色不变」在 Tailwind 一侧的证据；将 vite 构建放入单元测试成本过高。

### 人工验证

- **暗色：** Atlas Black、Chyral 在相同界面上改前改后并排对比，必须一致。
- **亮色：** 6 个主题逐一检查——聊天、文件树、编辑器与 diff、终端（ANSI 色）、知识与记忆图谱、mission-control 图表、团队聊天、弹窗与浮层（阴影）、mermaid。
- **System 模式：** 应用运行中切换系统外观。
- **冷启动：** 在**打包构建**中以亮色模式冷启动，确认无黑屏闪烁、启动脚本未被 CSP 拦截；删除缓存后冷启动确认回退为暗色。
- 截图附于 PR。

---

## 风险与待定项

| 项 | 说明 | 处理 |
|---|---|---|
| One Light 注释色可能低于底线 | 印象中官方值 `#a0a1a7` 在 `#fafafa` 上约 2.5:1，低于 `FLOOR` 3:1 | 先从上游核实真实值；若确实不达标，按仓库先例底线优先，微调至刚好 3:1 并在注释中说明偏离 |
| 人工分拣的判断误差 | 23 处 `text-white` 类用法需逐个判断 | 守卫测试白名单要求每条登记理由，评审可逐条复核 |
| Rust 测试本地不可运行 | 当前 Windows 开发机上 `cargo test -p atlas --lib` 的测试二进制加载失败（`0xc0000139`），与本改动无关 | 依赖 macOS CI 执行；PR 中如实说明 |
| `git-diff-panel.tsx` 被 grep 识别为二进制 | 文件含非文本字节 | codemod 须以文本方式读写该文件，改后核对 diff |
| 启动脚本被 CSP 拦截 | 该区域有记录在案的 CSP 故障史，开发模式无法暴露 | 必须在打包构建中验证；被拦截时后果是退回现状（暗色骨架屏），不会白屏 |

## 后续（不在本次范围）

- 暗色主题接管终端配色。
- 为 Chyral、Mirage、Phosphor、Vesper 等设计亮色孪生。
