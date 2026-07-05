/**
 * 查询写作规则（Procedural Memory）
 *
 * A1 工具。Agent 在续写前调用，按角色名和可选适用范围
 * 查询已持久化的写作规则，按置信度降序返回。
 */

import fs from "fs";
import path from "path";

function slugify(s) { return s.replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "novel"; }

let _querySkills = null, _getNovelBySlug = null;
try {
  const store = await import("../lib/store.js");
  _querySkills = store.querySkillsByCharacter;
  _getNovelBySlug = store.getNovelBySlug;
} catch(e) {}

export const name = "query-skills";
export const description = "查询写作规则。按角色名和可选适用范围查询已持久化的写作规则（skill_memories 表），按置信度降序返回。Agent 在续写涉及特定角色的段落时调用。";

export const parameters = {
  type: "object",
  properties: {
    slug: { type: "string", description: "小说 slug" },
    character_name: { type: "string", description: "角色名" },
    scope: { type: "string", description: "适用范围筛选（可选，如 对话、内心独白）。不填返回该角色所有规则" },
  },
  required: ["slug", "character_name"],
};

export async function execute(input, ctx) {
  const basePath = (ctx.config && ctx.config.novelBasePath) || "";
  if (!basePath) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "novelBasePath 未配置，请在插件设置中填写小说项目根目录路径。" }) }] };
  }

  if (!_querySkills || !_getNovelBySlug) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "store 未初始化" }) }] };
  }

  let projectPath = "";
  if (fs.existsSync(basePath)) {
    for (const e of fs.readdirSync(basePath, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (slugify(e.name) === input.slug) { projectPath = path.join(basePath, e.name); break; }
    }
  }
  if (!projectPath) return { content: [{ type: "text", text: JSON.stringify({ error: `未找到小说 '${input.slug}'` }) }] };

  let novel = _getNovelBySlug(slugify(path.basename(projectPath)));
  if (!novel) {
    try {
      const { upsertNovel } = await import("../lib/store.js");
      const r = upsertNovel({ slug: slugify(path.basename(projectPath)), title: path.basename(projectPath).replace(/^《|》$/g, ""), path: projectPath });
      novel = { id: r.lastInsertRowid, title: path.basename(projectPath) };
    } catch(e) { return { content: [{ type: "text", text: JSON.stringify({ error: "小说注册失败" }) }] }; }
  }

  const skills = _querySkills(novel.id, input.character_name, input.scope || null);

  return { content: [{
    type: "text",
    text: JSON.stringify({
      novel: novel.title || path.basename(projectPath),
      character: input.character_name,
      scope: input.scope || "全部",
      count: skills.length,
      skills: skills.map(s => ({
        id: s.id,
        scope: s.scope,
        rule: s.rule,
        confidence: s.confidence,
        source: s.source || "",
      })),
    }, null, 2)
  }] };
}
