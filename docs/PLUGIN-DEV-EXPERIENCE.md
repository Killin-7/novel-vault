# OpenHanako 插件开发踩坑记录

> novel-vault 插件开发过程中遇到的问题与解决方案。

---

## 一、环境背景

- **系统**：Windows
- **Hanako 版本**：0.82.0+
- **插件类型**：full-access（页面 + 路由 + Agent 工具）
- **数据方案**：直接解析用户 Markdown 文件（零存储开销）
- **UI 方案**：单 HTML SPA + OpenHanako 原生设计 token

---

## 二、已解决问题清单

### 问题 1：`better-sqlite3` 原生模块加载失败

**现象**：插件拖入后报错 `Could not locate the bindings file`。

**原因**：原生 C++ 模块需针对 Electron 的 Node.js 编译，用户环境不具备编译工具链。

**最终方案**：放弃 SQLite，改为直接解析项目 Markdown 文件（`章节规划.md`、`剧情汇总.md`、`伏笔与回收表.md`、`主角设定集.md`、`第X卷详细大纲.md`）。

**教训**：OpenHanako 插件应避免原生依赖。Markdown 解析用纯 JS 完全够用。

---

### 问题 2：`package.json` 触发 bindings 错误

**现象**：即使插件纯 JS 无依赖，`package.json` 存在就报 bindings 错误。

**原因**：Hanako 内部使用 better-sqlite3，插件 `package.json` 触发模块解析链，途经中文用户名路径时触发 Unicode 路径 bug。

**最终方案**：完全删除 `package.json`。插件入口的 `import`/`export` 由 Hanako 自身的 ESM 加载器处理。

**教训**：OpenHanako 插件**不**需要 `package.json`。

---

### 问题 3：`db/` 目录名触发 `module root` 错误

**现象**：无 `package.json` 但包含 `db/` 子目录时，报 `Could not find module root`。

**原因**：Hanako 对 `db/` 有特殊处理逻辑（可能用于内置数据库插件的路径推断）。

**最终方案**：重命名为 `lib/`（参考官方 `hanako-hyperframes` 插件的目录命名）。

**教训**：避免 `db/` 目录名，用 `lib/` 存放内部模块。

---

### 问题 4：iframe 页面显示"插件加载失败"

**现象**：插件安装成功，Tab 页面显示加载失败。

**原因**：iframe 需向宿主发送 `ready` 握手信号，Hanako 以此判断页面是否成功渲染。

**解决方案**：每个 HTML 文件末尾加入：

```html
<script>window.parent.postMessage({ type: 'ready' }, '*');</script>
```

**教训**：所有 iframe 页面**必须**发送 ready 握手，这是硬性要求。

---

### 问题 5：iframe 内 `fetch()` / XHR 返回 HTTP 403

**现象**：页面 HTML 正常加载，但 `fetch()` 任何 API 路由都返回 403。路由处理器根本没被执行。

**原因**：Hanako 安全模型区分请求类型——导航请求放行，脚本请求（`Sec-Fetch-Mode: cors`）拦截。

**最终方案**：彻底放弃 `fetch()`，改为服务端注入 `window.__DATA__`。

| 操作 | 原方案（❌） | 新方案（✅） |
|------|------------|------------|
| 读数据 | `fetch('./api/novels')` | 服务端注入 `window.__DATA__` |
| 写数据 | `fetch(..., {method:'POST'})` | Agent 工具直接写文件 |

**教训**：OpenHanako iframe 不能使用 `fetch()` / XHR。

---

### 问题 6：iframe 内任何页面导航返回 `{"error":"forbidden"}`

**现象**：iframe 内任何导航（`window.location.href`、`<a href>`、甚至同路径加 query param）都返回 `{"error":"forbidden"}`。

**原因**：Hanako 只允许 iframe 停留在 manifest 的 `page.route` 精确路径上。任何偏离都被拦截。

**最终方案**：改为 SPA 单页应用——所有 4 个视图在一个 HTML 文件中，通过 JavaScript DOM 切换实现客户端路由。

```javascript
// ❌ 不允许：iframe 内导航
window.location.href = './novel-list?view=plot-board';

// ✅ 允许：客户端 DOM 切换
nav('plot-board', { novelSlug: 'xxx' });  // 纯 JS，不改变 URL
```

**教训**：OpenHanako iframe 是"不可导航"容器，多视图必须用 SPA 客户端路由。

---

### 问题 7：Agent 工具未被注册

**现象**：工具文件存在于 `tools/` 目录，但 Agent 调用列表中不可见。

**原因**：manifest 缺少 `tools` 贡献声明。虽热工具文件会被扫描，但需在 `contributes` 中显式声明 `"tools": true` 才激活注册。

**最终方案**：manifest.json 添加：

```json
"contributes": {
  "page": { ... },
  "tools": true
}
```

**教训**：`tools/` 目录中的 `.js` 文件**不会自动注册**，必须在 manifest 中显式声明。

---

### 问题 8：正则表达式中的 `|` 导致角色解析崩溃（S 级 Bug）

**现象**：API 返回 500，所有数据不可用。根因在 `routes/api.js` 解析 `主角设定集.md` 时崩溃。

**原因**：

```javascript
// ❌ 错误写法
role: ef("身份|职业起点|角色定位")
```

`ef()` 函数将参数字符串直接拼入正则表达式。参数字符串中的 `|` 被当作正则交替运算符解析，导致捕获组错位。匹配「职业起点：xxx」时，`|` 把正则分裂为三个交替分支，目标分支不含捕获组，`r[1]` 为 `undefined`，`.trim()` 抛出 TypeError。

**最终方案**：用 `(?:...)` 非捕获组包裹：

```javascript
// ✅ 正确写法
role: ef("(?:身份|职业起点|角色定位|职业)")
```

**教训**：拼接正则时，参数字符串中的特殊字符（`|`、`.`、`?`等）必须用非捕获组包裹或转义。

---

### 问题 9：UI 外观与原生插件不一致

**现象**：初次版本使用硬编码颜色（`#1a1a2e` 深蓝底），在浅色主题下显示异常。

**原因**：没有使用 OpenHanako 通过 iframe 注入的 CSS 变量（`--bg`、`--accent`、`--text` 等），无法跟随主题切换。

**最终方案**：使用 `var(--base-var, fallback)` 模式适配所有主题 token：

```css
:root {
  --nv-bg:     var(--bg, #F8F5ED);
  --nv-accent: var(--accent, #537D96);
  --nv-text:   var(--text, #3B3D3F);
  /* ... */
}
```

已验证暖纸（浅色）和青夜（深色）两套主题下 UI 正常显示。设计语言对齐原生组件：玻璃态导航栏、8px 网格、6/10px 圆角、胶囊 badge、卡片悬浮阴影。

**教训**：所有颜色从 `var(--host-var, fallback)` 获取，fallback 值取浅色主题默认值。

---

## 三、兼容矩阵

| 主题 | --bg | --accent | 状态 |
|------|------|----------|------|
| 暖纸（默认） | #F8F5ED | #537D96 | ✅ 完美 |
| 青夜 | #3B4A54 | #C99AAF | ✅ 完美 |
| 其他内置主题 | 随主题变化 | 随主题变化 | ✅ 自动适配 |

---

## 四、最终插件结构

```
novel-vault/
├── manifest.json              # contributes: page + tools + configuration
├── index.js                   # 生命周期（极简）
├── routes/
│   └── api.js                 # Markdown 解析引擎 + 数据注入
├── frontend/
│   └── index-spa.html         # 单页应用（4 视图）
├── tools/
│   ├── archive-chapter.js     # 归档（直接写文件 + .bak）
│   ├── query-novel-state.js   # 查询（full/brief 双模式）
│   └── emotion-rhythm.js      # 情感节奏检测
├── docs/
│   ├── NOVEL-PROJECT-SPEC.md       # 小说项目格式规范
│   └── PLUGIN-DEV-EXPERIENCE.md    # 开发踩坑记录
├── .gitignore
├── LICENSE
└── README.md
```

---

## 五、开发铁律

1. **零外部依赖**：只依赖 Node.js 内置 `fs`、`path`
2. **无 `package.json`**：不仅不需要，反而触发 bug
3. **无 `fetch()`**：数据走服务端注入 `window.__DATA__`
4. **无 iframe 导航**：所有视图用 SPA 客户端 DOM 路由
5. **每个页面 ready 握手**：`postMessage({type:'ready'}, '*')`
6. **颜色走 CSS 变量**：`var(--host-var, fallback)` 适配所有主题
7. **manifest 声明 tools**：`"tools": true` 不可省略
8. **正则特殊字符加非捕获组**：`(?:a|b|c)` 而非裸 `a|b|c`
9. **参考官方插件**：`hanako-hyperframes` 的结构和命名习惯
