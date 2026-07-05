/**
 * 存入写作规则（Procedural Memory）
 *
 * A1 工具。纯存储工具——Agent 在修改角色台词/文风后自行提炼规则，
 * 调用本工具将规则持久化存入 skill_memories 表。
 * 本工具不做 LLM 提炼。
 */

import fs from "fs";
import path from "path";

function slugify(s) { return s.replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "novel"; }

let _insertSkill = null, _getNovelBySlug = null;
try {
  const store = await import("../lib/store.js");
  _insertSkill = store.insertSkillMemory;
  _getNovelBySlug = store.getNovelBySlug;
} catch(e) {}

export const name = "refine-skill";
export const description = "存入写作规则。Agent 在修改角色台词或文风后，将提炼出的写作规则持久化存入 skill_memories 表。纯存储工具，不做 LLM 提炼。";

export const parameters = {
  type: "object",
  properties: {
    slug: { type: "string", description: "小说 slug" },
    character_name: { type: "string", description: "角色名" },
    scope: { type: "string", description: "适用范围（如 对话、内心独白、第三人称叙述、全局）" },
    rule: { type: "string", description: "写作规则内容" },
    source: { type: "string", description: "来源修正案例描述（如 '第12章修改：压缩内心独白'）" },
    confidence: { type: "number", description: "置信度 0-1（默认 0.5）", default: 0.5 },
  },
  required: ["slug", "character_name", "scope", "rule"],
};

export async function execute(input, ctx) {
  const basePath = (ctx.config && ctx.config.novelBasePath) || "";
  if (!basePath) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "novelBasePath 未配置，请在插件设置中填写小说项目根目录路径。" }) }] };
  }

  if (!_insertSkill || !_getNovelBySlug) {
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

  const result = _insertSkill({
    novel_id: novel.id,
    character_name: input.character_name,
    scope: input.scope,
    rule: input.rule,
    source: input.source || "",
    confidence: input.confidence || 0.5,
  });

  // 显式持久化
  try { const { getDb } = await import("../lib/store.js"); getDb()._save(); } catch(e) {}

  return { content: [{
    type: "text",
    text: JSON.stringify({
      status: "ok",
      skill_id: result.lastInsertRowid,
      character: input.character_name,
      scope: input.scope,
      rule: input.rule,
    }, null, 2)
  }] };
}
