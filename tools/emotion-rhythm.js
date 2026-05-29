/**
 * 情感节奏检测（供 Agent 调用）
 *
 * 检测最近 N 章的情绪变化是否存在回环重复。
 * 日常恋爱文常见问题：换场景但情绪功能不变——连续几章都在"被照顾→感动→自我怀疑→被安抚"。
 */

import fs from "fs";
import path from "path";

function slugify(s) { return s.replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "novel"; }

// 情绪关键词库（中文常见情绪词）
const EMOTION_PATTERNS = [
  "被接住", "被照顾", "被看见", "被理解", "被安抚", "被需要",
  "感动", "温暖", "安心", "踏实", "放松", "释然", "安全感",
  "信任", "依赖", "亲近", "接纳", "归属感",
  "心动", "悸动", "害羞", "脸红", "甜蜜", "幸福", "满足",
  "自我怀疑", "自我否定", "不配得感", "不真实感",
  "不安", "焦虑", "紧张", "紧绷", "困惑", "困惑和",
  "委屈", "酸涩", "难过", "低落", "沮丧", "崩溃", "无助", "孤独",
  "尴尬", "社死", "局促", "不知所措",
  "愧疚", "自责", "亏欠", "过意不去",
  "压抑", "忍耐", "克制", "绷着",
  "松动", "触动", "确认感", "庆幸", "后怕",
  "惊讶", "意外", "不习惯", "被击中",
  "鼻子一酸", "眼眶发热", "心里一软",
];

function extractKeywords(text) {
  const found = [];
  for (const kw of EMOTION_PATTERNS) {
    if (text.includes(kw)) found.push(kw);
  }
  return found;
}

function jaccardSimilarity(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  const intersection = a.filter(x => b.includes(x)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

export const name = "detect-emotion-pattern";
export const description = "检测小说的情感节奏，标出连续章节中是否存在情绪回环重复。Agent 在写新章节前调用，避免陷入同类型情绪重复。";

export const parameters = {
  type: "object",
  properties: {
    slug: {
      type: "string",
      description: "小说 slug",
    },
    recentChapters: {
      type: "integer",
      description: "检查最近几章（默认3）",
      default: 3,
    },
  },
  required: ["slug"],
};

export async function execute(input, ctx) {
  const basePath = (ctx.config && ctx.config.novelBasePath) || "";
  if (!basePath) {
    return JSON.stringify({ error: "novelBasePath 未配置，请在插件设置中填写小说项目根目录路径。" }, null, 2);
  }
  const slug = input.slug;
  const recentN = input.recentChapters || 3;

  // 发现项目
  let projectPath = "";
  if (fs.existsSync(basePath)) {
    for (const e of fs.readdirSync(basePath, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sp = path.join(basePath, e.name);
      if (!fs.existsSync(path.join(sp, "章节规划.md"))) continue;
      if (slugify(e.name) === slug) { projectPath = sp; break; }
    }
  }

  if (!projectPath) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `未找到小说 '${slug}'` }) }] };
  }

  // 解析章节
  const fp = path.join(projectPath, "章节规划.md");
  if (!fs.existsSync(fp)) return { content: [{ type: "text", text: JSON.stringify({ error: "无章节规划" }) }] };
  const text = fs.readFileSync(fp, "utf-8");
  const chapters = []; let inTable = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("| 章节") && t.includes("状态")) { inTable = true; continue; }
    if (inTable && t.startsWith("|---")) continue;
    if (inTable && t === "") { inTable = false; continue; }
    if (!inTable || !t.startsWith("|")) continue;
    const cols = t.split("|").map(c => c.trim()).filter(c => c);
    if (cols.length < 2) continue;
    const m2 = cols[0].match(/第(\d+)章/); if (!m2) continue;
    chapters.push({ chapter_number: parseInt(m2[1], 10), status: cols[1] || "" });
  }

  // 解析剧情汇总
  const summaryPath = path.join(projectPath, "剧情汇总.md");
  const emotionByChapter = {};
  if (fs.existsSync(summaryPath)) {
    const stext = fs.readFileSync(summaryPath, "utf-8");
    const secs = stext.split(/^### 第(\d+)章$/gm);
    for (let i = 1; i < secs.length; i += 2) {
      const num = parseInt(secs[i], 10);
      const content = (secs[i + 1] || "").trim();
      const em = content.match(/- 情绪变化[：:]\s*([\s\S]*?)(?=\n-|$)/i);
      if (em) emotionByChapter[num] = em[1].trim().replace(/\n\s*/g, " ");
    }
  }

  // 取最近 N 章（已归档的）
  const archived = chapters.filter(c => c.status === "已归档").sort((a, b) => b.chapter_number - a.chapter_number);
  const recent = archived.slice(0, recentN).reverse();

  // 分析
  const analysis = [];
  for (const ch of recent) {
    const emText = emotionByChapter[ch.chapter_number] || "";
    const keywords = extractKeywords(emText);
    analysis.push({ chapter: ch.chapter_number, status: ch.status, emotion_text: emText.slice(0, 100), emotion_keywords: keywords });
  }

  // 检测重复
  const warnings = [];
  for (let i = 1; i < analysis.length; i++) {
    const prev = analysis[i - 1].emotion_keywords;
    const curr = analysis[i].emotion_keywords;
    const sim = jaccardSimilarity(prev, curr);
    if (sim > 0.4) {
      warnings.push({
        type: "情绪回环警告",
        chapters: [analysis[i - 1].chapter, analysis[i].chapter],
        overlap_keywords: prev.filter(k => curr.includes(k)),
        similarity: Math.round(sim * 100) + "%",
        suggestion: "建议在章节间引入不同的情绪功能，避免连续两章情绪体验雷同",
      });
    }
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        novel: slug,
        analyzed_range: `最近 ${recentN} 章`,
        chapters_analyzed: analysis,
        warnings: warnings.length > 0 ? warnings : [{ type: "ok", message: "未检测到明显的情绪回环，节奏正常" }],
      }, null, 2)
    }]
  };
}
