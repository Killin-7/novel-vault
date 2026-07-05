/**
 * novel-vault — Markdown 解析 + SPA 服务
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPA_HTML = fs.readFileSync(path.join(__dirname, "..", "frontend", "index-spa.html"), "utf-8");

function slugify(s) { return s.replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "novel"; }

// ─── 项目发现 ───
function discoverProjects(basePaths) {
  const projects = [];
  for (const bp of basePaths) {
    if (!fs.existsSync(bp)) continue;
    if (fs.existsSync(path.join(bp, "章节规划.md")) && fs.existsSync(path.join(bp, "正文"))) {
      projects.push({ name: path.basename(bp).replace(/^《|》$/g, ""), slug: slugify(path.basename(bp)), path: bp, root: bp });
      continue;
    }
    for (const e of fs.readdirSync(bp, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sp = path.join(bp, e.name);
      if (!fs.existsSync(path.join(sp, "章节规划.md"))) continue;
      projects.push({ name: e.name.replace(/^《|》$/g, ""), slug: slugify(e.name), path: sp, root: sp });
    }
  }
  return projects;
}

// ─── 章节规划解析 ───
function parseChapterPlan(fp) {
  if (!fs.existsSync(fp)) return { chapters: [], stats: {} };
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
    chapters.push({ chapter_number: parseInt(m2[1], 10), status: cols[1] || "", notes: cols[2] || "" });
  }
  const stats = {
    total: chapters.length,
    draft: chapters.filter(c => c.status === "草稿").length,
    archived: chapters.filter(c => c.status === "已归档").length,
    published: chapters.filter(c => c.status === "已发布").length,
    pending: chapters.filter(c => c.status === "待写" || !c.status).length
  };
  const ov = text.match(/总规划章节数[：:]\s*(\d+)/);
  if (ov) stats.totalPlanned = parseInt(ov[1], 10);
  return { chapters, stats };
}

// ─── 伏笔解析 ───
function parseForeshadowing(fp) {
  if (!fs.existsSync(fp)) return [];
  const items = []; let inTable = false;
  for (const line of fs.readFileSync(fp, "utf-8").split("\n")) {
    const t = line.trim();
    if (t.startsWith("| 编号") && t.includes("首次出现章节")) { inTable = true; continue; }
    if (inTable && t.startsWith("|---")) continue;
    if (inTable && !t.startsWith("| F") && !t.startsWith("|F")) { if (t === "" || t.startsWith("##")) inTable = false; continue; }
    if (!inTable || (!t.startsWith("| F") && !t.startsWith("|F"))) continue;
    const cols = t.split("|").map(c => c.trim()).filter(c => c);
    if (cols.length < 4) continue;
    const fcm = (cols[1] || "").match(/第(\d+)章/);
    const lcm = (cols[4] || "").match(/第(\d+)章/);
    // 跳过占位行（模板行含"第X章"）
    if (cols[1] && cols[1].includes("X")) continue;
    items.push({ id: cols[0], first_chapter: fcm ? parseInt(fcm[1], 10) : null, content: cols[2] || "", status: cols[3] || "", latest_chapter: lcm ? parseInt(lcm[1], 10) : null, notes: cols[5] || "" });
  }
  return items;
}

// ─── 剧情汇总解析 ───
function parseSummary(fp) {
  if (!fs.existsSync(fp)) return [];
  const summaries = [];
  const secs = fs.readFileSync(fp, "utf-8").split(/^### 第(\d+)章$/gm);
  for (let i = 1; i < secs.length; i += 2) {
    const num = parseInt(secs[i], 10); if (isNaN(num)) continue;
    const content = (secs[i + 1] || "").trim();
    const ex = (k) => { const m2 = content.match(new RegExp(`-\\s*${k}[：:]\\s*([\\s\\S]*?)(?=\\n-\\s*|$)`, "i")); return m2 ? m2[1].trim().replace(/\n\s*/g, " ") : ""; };
    summaries.push({ chapter_number: num, what: ex("发生了什么"), emotion: ex("情绪变化"), relation: ex("关系变化"), foreshadow: ex("伏笔推进或回收"), setting: ex("设定新增或确认") });
  }
  return summaries;
}

// ─── 章末钩子 ───
function parseChapterEnding(projectPath, chapterNum) {
  for (const sub of ["正文", "已发章节"]) {
    const fp = path.join(projectPath, sub, `第${chapterNum}章.md`);
    if (!fs.existsSync(fp)) continue;
    const text = fs.readFileSync(fp, "utf-8").replace(/^#{1,3}\s+.+/gm, "").replace(/\*\*|__/g, "").replace(/^[>|\-\*]\s*/gm, "").trim();
    return text.slice(-300).trim() || null;
  }
  return null;
}

// ─── 大纲解析 ───
function parseOutlines(projectPath) {
  const outlines = {};
  const dir = fs.readdirSync(projectPath);
  const outlineFiles = dir.filter(f => f.match(/第[一二三四五六七八九十\d]+卷.*大纲\.md$/));
  for (const filename of outlineFiles) {
    const vm = filename.match(/第([一二三四五六七八九十\d]+)卷/); if (!vm) continue;
    const volLabel = vm[1];
    const text = fs.readFileSync(path.join(projectPath, filename), "utf-8");
    const vnm = text.match(/\|\s*卷名暂?定\s*\|\s*\**(.+?)\**\s*\|/m) || text.match(/卷名暂?定[：:]\s*\**(.+?)\**\s*$/m);
    const rgm = text.match(/\|\s*章节范围\s*\|\s*\**(.+?)\**\s*\|/m) || text.match(/章节范围[：:]\s*\**(.+?)\**\s*$/m);
    const thm = text.match(/\|\s*核心主题\s*\|\s*(.+?)\s*\|/m) || text.match(/核心主题[：:]\s*(.+?)$/m);

    // 按 ## 第N章 分割（用字符串方法，跨平台安全）
    const chapters = [];
    const lines = text.split(/\r?\n/);
    let chapterNum = 0, chapterTitle = "", chapterBody = "";
    for (const line of lines) {
      const cm = line.match(/^## 第(\d+)章[:：](.*)/);
      if (cm) {
        if (chapterNum > 0 && chapterBody.trim()) {
          chapters.push(buildOutlineChapter(chapterNum, chapterTitle, chapterBody));
        }
        chapterNum = parseInt(cm[1], 10);
        chapterTitle = cm[2].trim();
        chapterBody = "";
      } else if (chapterNum > 0) {
        chapterBody += line + "\n";
      }
    }
    if (chapterNum > 0 && chapterBody.trim()) {
      chapters.push(buildOutlineChapter(chapterNum, chapterTitle, chapterBody));
    }

    if (chapters.length > 0) {
      outlines[volLabel] = {
        volume: volLabel,
        name: vnm ? vnm[1].replace(/\*\*/g, "").trim() : `第${volLabel}卷`,
        range: rgm ? rgm[1].replace(/\*\*/g, "").trim() : "",
        theme: thm ? thm[1].trim() : "",
        chapters,
      };
    }
  }
  return outlines;
}

function buildOutlineChapter(num, title, body) {
  const ex = (k) => {
    const re = new RegExp(`###\\s+(?:本章)?${k}\\s*\\n([\\s\\S]*?)(?=\\n###|$)`, "i");
    const m2 = body.match(re);
    return m2 ? m2[1].trim() : "";
  };
  return {
    chapter_number: num,
    outline_title: title,
    positioning: ex("本章定位"),
    scenes: ex("核心场景"),
    events: ex("核心事件"),
    emotion: ex("情绪推进"),
    relation: ex("关系推进"),
    hook: ex("章末钩子") || ex("尾钩设计"),
  };
}

// ─── 角色设定解析（扩展版：含深层字段）───
function parseCharacterSettings(fp) {
  if (!fs.existsSync(fp)) return [];
  const text = fs.readFileSync(fp, "utf-8");
  const characters = [];
  const re = /^## (.+?)$\n+(### \d+\. 基础信息[\s\S]*?)(?=^## |\n*$)/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim(); if (name.includes("设定") || name.includes("文档")) continue;
    const info = m[2];
    const ef = (k) => { const r = info.match(new RegExp(`-\\s*${k}[：:]\\s*(.+?)(?=\\n-|$)`, "i")); return r ? r[1].trim() : ""; };
    // 深度字段：搜索角色所属的整个 ## 区块
    const charBlock = new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\s\S]*?(?=^## |$)`, "m");
    const fullBlock = (text.match(charBlock) || [""])[0];
    const deepExtract = (sectionName) => {
      const secRe = new RegExp(`### \\d+\\. ${sectionName}[\s\S]*?(?=### \\d+\\.|^## |$)`, "m");
      const sec = (fullBlock.match(secRe) || [""])[0];
      if (!sec) return "";
      // 提取列表项
      const items = [];
      for (const line of sec.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- ") && !trimmed.startsWith("- **")) items.push(trimmed.replace(/^-\s*/, ""));
      }
      return items.join("；");
    };
    characters.push({
      name,
      age: ef("年龄"),
      role: ef("(?:身份|职业起点|角色定位|职业)"),
      keywords: ef("关键词"),
      description: ef("基础信息") || ef("背景"),
      speaking_style: deepExtract("说话方式"),
      emotional_triggers: deepExtract("情绪触发点"),
      intimacy_behavior: deepExtract("亲密关系表现"),
    });
  }
  return characters;
}

// ─── 从大纲构建角色状态序列 ───
function buildCharacterArcs(outlines, characters, chapters) {
  // 从大纲的「关系推进」「情绪推进」字段中按章节构建角色状态
  const arcData = [];
  for (const char of characters) {
    const states = [];
    for (const vol of Object.values(outlines)) {
      for (const olc of vol.chapters) {
        const ch = chapters.find(c => c.chapter_number === olc.chapter_number);
        const relationText = olc.relation || "";
        const emotionText = olc.emotion || "";
        if (!relationText && !emotionText) continue;
        // 检查是否涉及当前角色
        const nameInRelation = relationText.includes(char.name);
        const nameInEmotion = emotionText.includes(char.name);
        if (!nameInRelation && !nameInEmotion) continue;
        states.push({
          chapter_number: olc.chapter_number,
          chapter_title: ch?.title || "",
          state_summary: relationText.slice(0, 200),
          emotional_state: emotionText.slice(0, 200),
        });
      }
    }
    if (states.length > 0) {
      arcData.push({ character: char, states: states.sort((a, b) => a.chapter_number - b.chapter_number) });
    }
  }
  return arcData;
}
function buildData(basePaths) {
  return {
    novels: discoverProjects(basePaths).map(p => {
      const chPlan = parseChapterPlan(path.join(p.path, "章节规划.md"));
      const foreshadows = parseForeshadowing(path.join(p.path, "伏笔与回收表.md"));
      const summaries = parseSummary(path.join(p.path, "剧情汇总.md"));
      const characters = parseCharacterSettings(path.join(p.path, "主角设定集.md"));
      const outlines = parseOutlines(p.path);
      const charArcs = buildCharacterArcs(outlines, characters, chPlan.chapters);

      const chapters = chPlan.chapters.map((ch, idx) => {
        const s = summaries.find(s => s.chapter_number === ch.chapter_number);
        const ending = parseChapterEnding(p.path, ch.chapter_number);
        const prev3 = chPlan.chapters.slice(Math.max(0, idx - 3), idx).reverse().map(pch => {
          const ps = summaries.find(s => s.chapter_number === pch.chapter_number);
          return { chapter_number: pch.chapter_number, title: pch.notes || "", what: ps?.what || "" };
        });
        let outline = null;
        for (const vol of Object.values(outlines)) {
          const ol = vol.chapters.find(o => o.chapter_number === ch.chapter_number);
          if (ol) { outline = { volume: vol.volume, name: vol.name, ...ol }; break; }
        }
        // 从弧数据中提取本章的角色状态
        const charStates = charArcs.flatMap(a => a.states.filter(s => s.chapter_number === ch.chapter_number).map(s => ({
          name: a.character.name, state_summary: s.state_summary, emotional_state: s.emotional_state
        })));
        return { ...ch, ...(s || {}), title: outline?.outline_title || (ch.notes ? ch.notes.split("。")[0] : ""), ending_hook: ending, prev_chapters: prev3, outline, character_states: charStates };
      });

      const activeF = foreshadows.filter(f => f.status === "已埋下" || f.status === "推进中");
      return {
        id: p.slug, title: p.name, slug: p.slug, path: p.path,
        chapter_count: chapters.length, archived_count: chPlan.stats.archived || 0,
        published_count: chPlan.stats.published || 0, unresolved_count: activeF.length,
        total_planned: chPlan.stats.totalPlanned || chapters.length,
        chapters,
        plotPoints: foreshadows.map(f => ({
          id: f.id, title: f.content.length > 100 ? f.content.slice(0, 100) + "..." : f.content,
          description: f.content,
          status: f.status === "已回收" ? "resolved" : (f.status === "搁置" ? "shelved" : "active"),
          importance: f.status === "已回收" ? 5 : 3,
          planted_chapter_num: f.first_chapter, resolved_chapter_num: f.status === "已回收" ? f.latest_chapter : null, notes: f.notes
        })),
        characters: characters.map(c => {
          const arc = charArcs.find(a => a.character.name === c.name);
          return {
            id: slugify(c.name), name: c.name, role: c.role || c.keywords || "",
            description: c.description || "",
            speaking_style: c.speaking_style || "",
            emotional_triggers: c.emotional_triggers || "",
            arc: arc ? arc.states : [],
          };
        }),
        outlines: Object.keys(outlines).length > 0 ? outlines : null,
      };
    })
  };
}

// ═══════════ 路由 ═══════════
export default function (app, ctx) {
  function inject(html, data) {
    const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/-->/g, "--\\>");
    return html.replace("/*__DATA__*/", json);
  }
  const config = ctx.config || {};
  const basePaths = config.novelBasePath ? [config.novelBasePath] : [];

  app.get("/novel-list", async (c) => {
    const data = buildData(basePaths);
    // 自动同步小说到 store
    try {
      const store = await import("../lib/store.js");
      for (const novel of data.novels) {
        try { store.upsertNovel({ slug: novel.slug, title: novel.title, path: novel.path }); } catch(e) {}
      }
    } catch(e) {}
    return c.html(inject(SPA_HTML, data));
  });
  app.post("/novel-list", async () => new Response(null, { status: 302, headers: { Location: "/api/plugins/novel-vault/novel-list" } }));
}
