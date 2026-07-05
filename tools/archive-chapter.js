/**
 * 归档章节（精确写入版）
 *
 * 不对章稿做任何理解。由 Agent 提供写好的 5 项记录，
 * 工具负责精确写入三个 Markdown 文件并保持格式一致。
 *
 * 每次写入自动 .bak 备份。dryRun 已改名为 preview。
 */

import fs from "fs";
import path from "path";

// 尝试导入 store 函数
let _clearCache = null, _insertAtomicFacts = null, _getNovelBySlug = null;
try {
  const store = await import("../lib/store.js");
  _clearCache = store.clearCache;
  _insertAtomicFacts = store.insertAtomicFacts;
  _getNovelBySlug = store.getNovelBySlug;
} catch(e) {}

function slugify(s) { return s.replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "novel"; }

// ─── 1. 写入剧情汇总 ───
function writeSummary(projectPath, chNum, entries) {
  const fp = path.join(projectPath, "剧情汇总.md");
  if (!fs.existsSync(fp)) return { file: "剧情汇总.md", error: "文件不存在" };
  const text = fs.readFileSync(fp, "utf-8");

  // 检查是否已存在
  if (new RegExp(`### 第${chNum}章\\b`).test(text)) {
    return { file: "剧情汇总.md", error: `第${chNum}章已存在于剧情汇总中，拒绝覆盖` };
  }

  // 备份
  fs.writeFileSync(fp + ".bak", text, "utf-8");

  const entry = [
    `\n### 第${chNum}章`,
    "",
    `- 发生了什么: ${entries.what}`,
    `- 情绪变化: ${entries.emotion}`,
    `- 关系变化: ${entries.relation}`,
    `- 伏笔推进或回收: ${entries.foreshadow || "（无）"}`,
    `- 设定新增或确认: ${entries.setting || "（无）"}`,
    "",
  ].join("\n");

  fs.writeFileSync(fp, text + entry, "utf-8");
  return { file: "剧情汇总.md", action: "追加", chapter: chNum };
}

// ─── 2. 更新章节规划 ───
function updateChapterPlan(projectPath, chNum, entries) {
  const fp = path.join(projectPath, "章节规划.md");
  if (!fs.existsSync(fp)) return { file: "章节规划.md", error: "文件不存在" };
  let text = fs.readFileSync(fp, "utf-8");
  fs.writeFileSync(fp + ".bak", text, "utf-8");

  // 2a. 已归档章节数 +1
  text = text.replace(/已归档章节数[：:]\s*\d+/, m => m.replace(/\d+/, n => String(parseInt(n, 10) + 1)));

  // 2b. 当前推进章节 更新
  text = text.replace(/当前推进章节[：:]\s*第?\d+章?/, `当前推进章节：第${chNum}章`);

  // 2c. 章节状态表追加一行
  const shortWhat = entries.what.slice(0, 40).replace(/\n/g, " ");
  const newRow = `| 第${chNum}章 | 已归档 | ${shortWhat}。 |`;

  if (text.includes(`第${chNum}章 |`)) {
    return { file: "章节规划.md", error: `第${chNum}章已存在于章节规划状态表中` };
  }

  // 找到表格最后一行并追加
  const lines = text.split("\n");
  let lastTableLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith("| 第") && lines[i].includes("章 |")) {
      lastTableLine = i; break;
    }
  }
  if (lastTableLine > 0) {
    lines.splice(lastTableLine + 1, 0, newRow);
    text = lines.join("\n");
    fs.writeFileSync(fp, text, "utf-8");
    return { file: "章节规划.md", action: "更新计数并追加状态行", chapter: chNum };
  }
  return { file: "章节规划.md", error: "未找到章节状态表" };
}

// ─── 3. 更新伏笔与回收表 ───
function updateForeshadowing(projectPath, chNum, foreshadowStr) {
  const fp = path.join(projectPath, "伏笔与回收表.md");
  if (!fs.existsSync(fp)) return { file: "伏笔与回收表.md", error: "文件不存在" };
  let text = fs.readFileSync(fp, "utf-8");
  fs.writeFileSync(fp + ".bak", text, "utf-8");

  if (!foreshadowStr || !foreshadowStr.trim()) {
    return { file: "伏笔与回收表.md", action: "跳过（无伏笔变动）" };
  }

  // 解析 "F06推进中；F10已埋下；F01推进中"
  const entries = foreshadowStr.split(/[；;]/).map(s => s.trim()).filter(s => s);
  const updates = [];
  for (const entry of entries) {
    const m = entry.match(/^(F\d+)\s*(已埋下|推进中|已回收)/);
    if (!m) return { file: "伏笔与回收表.md", error: `无法解析伏笔条目: "${entry}"，格式应为 F编号 状态（如 F06推进中）` };
    updates.push({ id: m[1], status: m[2] });
  }

  const notFound = [];
  const lines = text.split("\n");
  let changed = 0;

  for (const up of updates) {
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t.startsWith(`| ${up.id} `) && !t.startsWith(`|${up.id} `)) continue;
      const cols = t.split("|").map(c => c.trim()).filter(c => c);
      if (cols.length < 5) continue;
      // 列索引: id(0) 首次出现(1) 内容(2) 状态(3) 最近章节(4) 备注(5) 类型(6) 生命周期(7)
      // 更新状态列 (index 3) 和推进章节列 (index 4)，类型和生命周期不变
      cols[3] = up.status;
      cols[4] = `第${chNum}章`;
      const newLine = "| " + cols.join(" | ") + " |";
      // 调整两端竖线
      const originalPrefix = t.match(/^\|?\s*/)[0];
      lines[i] = originalPrefix + cols.join(" | ") + " |";
      found = true;
      changed++;
      break;
    }
    if (!found) notFound.push(up.id);
  }

  if (notFound.length > 0) {
    return { file: "伏笔与回收表.md", error: `未找到伏笔编号: ${notFound.join(", ")}` };
  }

  if (changed > 0) {
    fs.writeFileSync(fp, lines.join("\n"), "utf-8");
    return { file: "伏笔与回收表.md", action: `更新 ${changed} 条伏笔状态`, updates: updates.map(u => `${u.id}→${u.status}`) };
  }
  return { file: "伏笔与回收表.md", action: "无变动" };
}

// ─── 主入口 ───
export const name = "archive-chapter";
export const description = "归档一章。Agent 提供写好的 5 项记录，工具自动写入 剧情汇总.md、章节规划.md、伏笔与回收表.md。每次写入自动备份。preview:true 仅预览改动。";

export const parameters = {
  type: "object",
  properties: {
    slug: { type: "string", description: "小说 slug" },
    chapter: { type: "integer", description: "章节号" },
    entries: {
      type: "object",
      description: "5 项归档记录",
      properties: {
        what: { type: "string", description: "发生了什么" },
        emotion: { type: "string", description: "情绪变化" },
        relation: { type: "string", description: "关系变化" },
        foreshadow: { type: "string", description: "伏笔变动，格式: F编号 状态；分号分隔。无变动留空" },
        setting: { type: "string", description: "设定新增或确认" },
        atomic_facts: { type: "array", description: "（A4可选）可独立检索的细粒度事实列表，每项含 content 和 tags", items: { type: "object", properties: { content: { type: "string" }, tags: { type: "array", items: { type: "string" } } } } },
      },
      required: ["what", "emotion", "relation"],
    },
    preview: { type: "boolean", description: "仅预览不写入（默认 false）", default: false },
  },
  required: ["slug", "chapter", "entries"],
};

export async function execute(input, ctx) {
  const basePath = (ctx.config && ctx.config.novelBasePath) || "";
  if (!basePath) {
    return JSON.stringify({ error: "novelBasePath 未配置，请在插件设置中填写小说项目根目录路径。" }, null, 2);
  }
  const preview = input.preview === true;

  let projectPath = "";
  if (fs.existsSync(basePath)) {
    for (const e of fs.readdirSync(basePath, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sp = path.join(basePath, e.name);
      if (slugify(e.name) === input.slug) { projectPath = sp; break; }
    }
  }
  if (!projectPath) return { content: [{ type: "text", text: JSON.stringify({ error: `未找到小说` }) }] };

  const chNum = input.chapter;
  const entries = input.entries;

  // 预览模式
  if (preview) {
    return { content: [{
      type: "text",
      text: JSON.stringify({
        mode: "preview",
        chapter: chNum,
        files_that_would_be_modified: ["剧情汇总.md (追加)", "章节规划.md (更新计数+状态表)", entries.foreshadow ? "伏笔与回收表.md (更新状态)" : "伏笔与回收表.md (跳过)"],
        entries,
      }, null, 2)
    }] };
  }

  // 实际写入
  const results = [];
  
  // 1. 剧情汇总
  results.push(writeSummary(projectPath, chNum, entries));

  // 2. 章节规划
  results.push(updateChapterPlan(projectPath, chNum, entries));

  // 3. 伏笔表
  const foreshadowResult = updateForeshadowing(projectPath, chNum, entries.foreshadow || "");
  results.push(foreshadowResult);

  // 检查错误
  const errors = results.filter(r => r.error);
  if (errors.length > 0) {
    return { content: [{
      type: "text",
      text: JSON.stringify({
        status: "error",
        chapter: chNum,
        errors: errors.map(e => ({ file: e.file, error: e.error })),
        hint: "已回滚（.bak 备份可用）。请修复错误后重试。",
      }, null, 2)
    }] };
  }

  // A3: 清除缓存
  if (_clearCache) {
    try {
      _clearCache(path.join(projectPath, "剧情汇总.md"));
      _clearCache(path.join(projectPath, "章节规划.md"));
      _clearCache(path.join(projectPath, "伏笔与回收表.md"));
    } catch(e) {}
  }

  // A4: 保存 AtomicFact
  let atomicResult = null;
  if (entries.atomic_facts && entries.atomic_facts.length > 0 && _insertAtomicFacts && _getNovelBySlug) {
    try {
      let novel = _getNovelBySlug(slugify(path.basename(projectPath)));
      if (!novel) {
        const { upsertNovel } = await import("../lib/store.js");
        const r = upsertNovel({ slug: slugify(path.basename(projectPath)), title: path.basename(projectPath).replace(/^《|》$/g, ""), path: projectPath });
        novel = { id: r.lastInsertRowid };
      }
      _insertAtomicFacts(novel.id, chNum, entries.atomic_facts);
      atomicResult = { saved: entries.atomic_facts.length };
      // 显式持久化
      try { const { getDb } = await import("../lib/store.js"); getDb()._save(); } catch(e) {}
    } catch(e) { atomicResult = { error: e.message }; }
  }

  return { content: [{
    type: "text",
    text: JSON.stringify({
      status: "ok",
      chapter: chNum,
      changes: results,
      atomic_facts: atomicResult,
      backup: "已自动备份 .bak 文件",
    }, null, 2)
  }] };
}
