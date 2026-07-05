/**
 * 检索细粒度事实（AtomicFact）
 *
 * A4 工具。Agent 在续写特定场景前调用，
 * 按角色名或关键词检索历史章节中的原子事实。
 */

import fs from "fs";
import path from "path";

function slugify(s) { return s.replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "novel"; }

// 尝试导入 store 函数
let _searchFacts = null, _getNovelBySlug = null;
try {
  const store = await import("../lib/store.js");
  _searchFacts = store.searchAtomicFacts;
  _getNovelBySlug = store.getNovelBySlug;
} catch(e) {}

export const name = "search-facts";
export const description = "检索小说中的细粒度事实（AtomicFact）。输入角色名或关键词，返回相关历史章节中的关键事件片段。Agent 在续写涉及特定角色或场景时调用，确保细节不遗忘。";

export const parameters = {
  type: "object",
  properties: {
    slug: { type: "string", description: "小说 slug" },
    query: { type: "string", description: "查询关键词，支持逗号分隔多词（如 '顾辞,苏念,感情升温'）" },
  },
  required: ["slug", "query"],
};

export async function execute(input, ctx) {
  const basePath = (ctx.config && ctx.config.novelBasePath) || "";
  if (!basePath) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "novelBasePath 未配置，请在插件设置中填写小说项目根目录路径。" }) }] };
  }
  const slug = input.slug;
  const query = input.query || "";

  if (!_searchFacts || !_getNovelBySlug) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "store 未初始化，无法检索事实。请确保插件已正常加载。" }) }] };
  }

  // 查找项目
  let projectPath = "";
  if (fs.existsSync(basePath)) {
    for (const e of fs.readdirSync(basePath, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (slugify(e.name) === slug) { projectPath = path.join(basePath, e.name); break; }
    }
  }
  if (!projectPath) return { content: [{ type: "text", text: JSON.stringify({ error: `未找到小说 '${slug}'` }) }] };

  let novel = _getNovelBySlug(slugify(path.basename(projectPath)));
  if (!novel) {
    // 自动注册（首次使用工具时小说可能未同步）
    try {
      const { upsertNovel } = await import("../lib/store.js");
      const r = upsertNovel({ slug: slugify(path.basename(projectPath)), title: path.basename(projectPath).replace(/^《|》$/g, ""), path: projectPath });
      novel = { id: r.lastInsertRowid, title: path.basename(projectPath) };
    } catch(e) { return { content: [{ type: "text", text: JSON.stringify({ error: "小说注册失败" }) }] }; }
  }

  const facts = _searchFacts(novel.id, query);

  return { content: [{
    type: "text",
    text: JSON.stringify({
      novel: novel.title || path.basename(projectPath),
      query,
      count: facts.length,
      facts: facts.map(f => ({
        chapter: f.chapter,
        content: f.content,
        tags: f.tags ? f.tags.split(",") : [],
      })),
    }, null, 2)
  }] };
}
