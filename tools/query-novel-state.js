/**
 * 查询小说当前状态（供 Agent 调用）
 *
 * 用法：Agent 调用此工具获取指定小说的完整状态快照，包括：
 *   - 章节列表及状态
 *   - 剧情汇总
 *   - 活跃/已回收伏笔
 *   - 角色信息及状态弧
 *   - 大纲对照数据
 *   - Strand Weave 节奏分析
 *   - 角色状态序列化（从剧情汇总）
 *   - L0/L1/L2 分层上下文（brief 模式）
 */

import fs from "fs";
import path from "path";

function slugify(s) { return s.replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "novel"; }

// ─── 复用解析函数 ───
function parseChapterPlan(fp) {
  if (!fs.existsSync(fp)) return [];
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
  return chapters;
}

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
    items.push({ 
      id: cols[0], 
      content: cols[2] || "", 
      status: cols[3] || "",
      type: cols.length >= 7 ? cols[6] || "" : "",
      lifecycle: cols.length >= 8 ? cols[7] || "" : "",
    });
  }
  return items;
}

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

// ═════════════════════════════════════════
// Strand Weave 节奏分析
// ═════════════════════════════════════════

const STRAND_KEYWORDS = {
  quest: [
    "冲突", "战斗", "对抗", "危机", "敌人", "调查", "追查", "解决",
    "任务", "目标", "行动", "决定", "选择", "面对", "挑战", "突破",
    "上班", "面试", "试工", "辞职", "工作", "考核", "竞争",
    "老周", "保安", "同事", "领导", "工资", "收入"
  ],
  fire: [
    "心动", "心跳", "吃醋", "在意", "暧昧", "甜蜜", "害羞", "脸红",
    "靠近", "对视", "牵手", "拥抱", "触碰", "独处", "两个人",
    "照顾", "被照顾", "习惯", "默认", "默契", "依赖", "可依靠",
    "担心", "心疼", "保护", "护着", "陪伴",
    "关系", "感情", "升温", "试探", "确认"
  ],
  constellation: [
    "世界", "设定", "规则", "势力", "系统", "历史", "背景",
    "发现", "揭示", "真相", "秘密", "过去", "回忆",
    "超市", "营业", "小区", "社区", "邻居", "环境",
    "日常", "节奏", "习惯", "流程", "安排"
  ]
};

const STRAND_LABELS = { quest: "⚔️ 主线(Quest)", fire: "💕 感情(Fire)", constellation: "🌍 世界观(Constellation)", unknown: "❓ 未分类" };
const STRAND_THRESHOLDS = { quest: 5, fire: 10, constellation: 15 };

function classifyStrand(summary) {
  const text = (summary.what || "") + " " + (summary.relation || "") + " " + (summary.emotion || "");
  if (!text.trim()) return "unknown";
  const scores = {};
  for (const [strand, keywords] of Object.entries(STRAND_KEYWORDS)) {
    scores[strand] = keywords.filter(k => text.includes(k)).length;
  }
  // 关系变化 > 20 字 → Fire 权重 +3
  if (summary.relation && summary.relation.length > 20) scores.fire = (scores.fire || 0) + 3;
  // 情绪变化 > 15 字 → Fire 权重 +2
  if (summary.emotion && summary.emotion.length > 15) scores.fire = (scores.fire || 0) + 2;
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : "unknown";
}

function analyzeStrandWeave(summaries, chapters) {
  const archived = chapters.filter(c => c.status === "已归档").map(c => c.chapter_number);
  const relevant = summaries
    .filter(s => archived.includes(s.chapter_number))
    .sort((a, b) => a.chapter_number - b.chapter_number);

  if (relevant.length < 3) return null;

  const seq = relevant.map(s => classifyStrand(s));
  const labels = relevant.map(s => s.chapter_number);

  // 最近 5 章分布
  const recent = seq.slice(-5);
  const recentLabels = labels.slice(-5);
  const dist = { quest: 0, fire: 0, constellation: 0, unknown: 0 };
  recent.forEach(s => { dist[s] = (dist[s] || 0) + 1; });
  const total = recent.length;

  // 断档检测
  const gaps = [];
  for (const strand of ["quest", "fire", "constellation"]) {
    const lastIndex = seq.lastIndexOf(strand);
    const gap = lastIndex === -1 ? seq.length : seq.length - 1 - lastIndex;
    const limit = STRAND_THRESHOLDS[strand] || 5;
    const strandCN = strand === "quest" ? "主线" : strand === "fire" ? "感情线" : "世界观";
    if (gap >= limit) {
      gaps.push({ strand, gap, limit, warning: `${strandCN}已断档 ${gap} 章（红线 ${limit} 章）` });
    } else if (gap >= limit * 0.7) {
      gaps.push({ strand, gap, limit, warning: `${strandCN}接近断档（${gap}/${limit}章）` });
    }
  }

  // 最近章节的 strand 序列
  const strandPattern = recentLabels.map((ch, i) => ({
    chapter: ch,
    strand: recent[i],
    strandLabel: STRAND_LABELS[recent[i]]
  }));

  return {
    recent_distribution: `主线 ${dist.quest}/${total}  感情 ${dist.fire}/${total}  世界观 ${dist.constellation}/${total}`,
    strand_sequence: strandPattern,
    warnings: gaps.length > 0 ? gaps.map(g => g.warning) : [],
    healthy: gaps.length === 0
  };
}

// ═════════════════════════════════════════
// 辅助：大纲解析（提取指定章）
// ═════════════════════════════════════════

function findOutlineFile(projectPath) {
  if (!fs.existsSync(projectPath)) return null;
  const dir = fs.readdirSync(projectPath);
  const files = dir.filter(f => f.match(/第[一二三四五六七八九十\d]+卷.*大纲\.md$/));
  if (files.length === 0) return null;
  return path.join(projectPath, files[0]);
}

// 从大纲文本中提取指定章节的字段
function parseOutlineChapter(olText, chNum) {
  const chReg = new RegExp(`### 第${chNum}章[^\n]*\n([\\s\\S]*?)(?=### 第\\d+章|$)`);
  const sec = olText.match(chReg);
  if (!sec) return null;
  const body = sec[1];
  const ex = (k) => {
    const m = body.match(new RegExp(`-\\s*${k}[：:]\\s*([\\s\\S]*?)(?=\\n-|$)`, "i"));
    return m ? m[1].trim().replace(/\n\s*/g, " ") : "";
  };
  return {
    positioning: ex("本章定位") || ex("定位"),
    scenes: ex("核心场景") || ex("场景"),
    events: ex("核心事件") || ex("事件"),
    emotion: ex("情绪推进") || ex("情绪"),
    relation: ex("关系推进") || ex("关系"),
    hook: ex("章末钩子") || ex("尾钩设计") || ex("尾钩"),
  };
}

// ═════════════════════════════════════════
// 角色状态序列化（从剧情汇总）
// ═════════════════════════════════════════

function buildCharacterStates(projectPath, summaries, latestChapter) {
  const chars = {};
  const settingPath = path.join(projectPath, "主角设定集.md");
  if (!fs.existsSync(settingPath)) return chars;
  const sText = fs.readFileSync(settingPath, "utf-8");
  // 匹配所有 ## 标题，过滤掉编号标题（如 ## 1. xxx, ## 一、xxx）
  const h2Matches = sText.match(/^##\s+(.+?)$/gm);
  if (!h2Matches) return chars;
  const charNames = h2Matches
    .map(m => m.replace(/^##\s+/, "").trim())
    .filter(n => n && !/^\d+[.、]/.test(n) && !/^[一二三四五六七八九十]+[、]/.test(n) && n.length <= 6);
  
  for (const name of charNames) {
    const relevant = summaries
      .filter(s => s.chapter_number <= latestChapter && (s.emotion || s.relation))
      .sort((a, b) => a.chapter_number - b.chapter_number);
    if (relevant.length === 0) continue;
    const last = relevant[relevant.length - 1];
    // 取最新章的关系变化作为当前状态描述
    const currentRel = last.relation || "";
    const currentEmo = last.emotion || "";
    chars[name] = {
      current: currentRel.slice(0, 200) || "（暂无关系状态记录）",
      latest_emotion: currentEmo.slice(0, 150) || "",
      reason: `由 剧情汇总.md 第1-${latestChapter}章「关系变化」「情绪变化」字段序列化`,
    };
  }
  return chars;
}

// ═════════════════════════════════════════
// 约束解析
// ═════════════════════════════════════════

function buildConstraints(projectPath) {
  const cf = path.join(projectPath, "写作约束.md");
  if (!fs.existsSync(cf)) return [];
  const text = fs.readFileSync(cf, "utf-8");
  // 从表格中提取约束行
  const constraints = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || t.includes("约束") && t.includes("优先级")) continue;
    if (t.startsWith("|---")) continue;
    const cols = t.split("|").map(c => c.trim()).filter(c => c);
    if (cols.length < 2) continue;
    if (cols[0] === "约束" || cols[0] === "范围") continue;
    constraints.push({ constraint: cols[0], scope: cols[1] || "全篇", priority: cols[2] || "" });
  }
  return constraints;
}

// ═════════════════════════════════════════
// 角色约束提取 (主角设定集 → character_bounds)
// ═════════════════════════════════════════

function parseCharacterBounds(projectPath) {
  const fp = path.join(projectPath, "主角设定集.md");
  if (!fs.existsSync(fp)) return {};
  const lines = fs.readFileSync(fp, "utf-8").split("\n");
  
    // 查找所有 bounds 标记，同时确定其标题级别
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s.*<!--\s*bounds:(\w+(-\w+)*)\s*-->/);
    if (m) markers.push({ id: m[2], line: i, headingLevel: m[1].length });
  }
  if (markers.length === 0) return {};
  
  // 提取内容：锚点行之后到下一个同级别或更高级别的标题
  const sections = {};
  for (let mi = 0; mi < markers.length; mi++) {
    const { id, line, headingLevel } = markers[mi];
    const nextLine = mi + 1 < markers.length ? markers[mi + 1].line : lines.length;
    let endLine = nextLine;
    for (let j = line + 1; j < nextLine; j++) {
      const t = lines[j].trim();
      const hm = t.match(/^(#{1,6})s/);
      if (hm && hm[1].length <= headingLevel && !t.includes("<!--")) {
        endLine = j;
        break;
      }
    }
    const content = lines.slice(line + 1, endLine).join("\n").trim();
    if (content) sections[id] = content;
  }
  
  // 按角色分组
  const result = { guci: {}, shen: {}, both: {} };
  for (const [id, content] of Object.entries(sections)) {
    const parts = id.split("-");
    const prefix = parts[0];
    const key = parts.slice(1).join("_");
    if (result[prefix]) result[prefix][key] = content;
  }
  // 清空空分组
  for (const k of ["guci", "shen", "both"]) {
    if (Object.keys(result[k]).length === 0) delete result[k];
  }
  return result;
}

// ═════════════════════════════════════════
// L2 锚点索引 (配角设定集 + 小区地图 => l2-index)
// ═════════════════════════════════════════

function buildL2Index(projectPath) {
  const indexFiles = ["关键配角设定集.md", "小区地图式设定.md"];
  const index = [];
  for (const fn of indexFiles) {
    const fp = path.join(projectPath, fn);
    if (!fs.existsSync(fp)) continue;
    const lines = fs.readFileSync(fp, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/<!--\s*l2-ref:\s*(\S+)\s*-->/);
      if (m) {
        const heading = lines[i].replace(/<!--.*-->/, "").trim();
        index.push({
          ref: m[1],
          source: fn,
          heading,
          line: i + 1,
        });
      }
    }
  }
  return index;
}

// ═════════════════════════════════════════
// L0/L1/L2 简报构建
// ═════════════════════════════════════════

function buildBrief(project, chapters, foreshadows, summaries) {
  const archived = chapters.filter(c => c.status === "已归档").sort((a, b) => b.chapter_number - a.chapter_number);
  const latest = archived[0] || null;
  const lastChapterNum = latest ? latest.chapter_number : 0;
  const targetChapter = lastChapterNum + 1;
  const allDone = chapters.length > 0 && chapters.every(c => c.status === "已归档");

  // ── 大纲文件 ──
  const outlinePath = findOutlineFile(project.path);
  const olText = (outlinePath && fs.existsSync(outlinePath)) ? fs.readFileSync(outlinePath, "utf-8") : "";

  // ═══ L0：写前必读 ═══
  const L0 = {};

  // current_phase
  if (olText) {
    const phaseMatch = olText.match(/总体阶段划分\n([\s\S]*?)(?=\n## |\n# |$)/);
    if (phaseMatch) {
      const phases = phaseMatch[1].match(/- \*\*第?(\d+-\d+)章[：:](.+?)\*\*/g);
      if (phases && latest) {
        for (const p of phases.reverse()) {
          const rm = p.match(/第?(\d+)-(\d+)章[：:](.+)/);
          if (rm && latest.chapter_number >= parseInt(rm[1], 10)) {
            L0.current_phase = {
              value: `${rm[1]}-${rm[2]}章：${rm[3].replace(/\*\*/g, "").trim()}`,
              reason: `章节号 ${latest.chapter_number} 落在该阶段范围内（大纲「总体阶段划分」）`,
            };
            break;
          }
        }
      }
    }
    const focusMatch = olText.match(/写作重心[：:]\s*(.+?)(?=\n|$)/m) || olText.match(/核心主题[：:]\s*(.+?)$/m);
    if (focusMatch) {
      L0.writing_focus = { value: focusMatch[1].trim(), reason: "大纲「写作重心」字段" };
    }
  }

  // current_relation
  if (latest && summaries.length > 0) {
    const ls = summaries.find(s => s.chapter_number === latest.chapter_number);
    if (ls && ls.relation) {
      L0.current_relation = {
        value: ls.relation.slice(0, 200),
        reason: `由 剧情汇总.md 第${latest.chapter_number}章「关系变化」提取`,
      };
    }
    // latest_hook
    const chPath = path.join(project.path, "正文", `第${latest.chapter_number}章.md`);
    if (fs.existsSync(chPath)) {
      const chText = fs.readFileSync(chPath, "utf-8");
      const hook = chText.replace(/^#{1,3}\s+.+/gm, "").replace(/\*\*/g, "").trim().slice(-200).trim();
      if (hook) {
        L0.latest_hook = {
          value: hook,
          reason: `正文/第${latest.chapter_number}章.md 末尾 200 字`,
        };
      }
    }
  }

  // active_constraints
  const constraints = buildConstraints(project.path);
  if (constraints.length > 0) {
    L0.active_constraints = constraints.map(c => ({
      ...c,
      reason: "写作约束.md 表格提取",
    }));
  }

  // ═══ L1：目录感知 ═══
  const L1 = {};

  // strand
  const strandResult = analyzeStrandWeave(summaries, chapters);
  if (strandResult) {
    L1.strand_sequence = strandResult.strand_sequence.map(s => ({
      ...s,
      reason: `按剧情汇总章节序列标注，总计 ${strandResult.strand_sequence.length} 章`,
    }));
    if (strandResult.warnings.length > 0) {
      L1.strand_warnings = strandResult.warnings.map(w => ({ value: w, reason: "全章序列断档检测" }));
    }
  }

  // active_foreshadows (按章号过滤)
  const active = foreshadows.filter(f => (f.status === "已埋下" || f.status === "推进中"));
  if (active.length > 0) {
    L1.active_foreshadows = active.map(f => ({
      id: f.id,
      summary: f.content.slice(0, 80),
      status: f.status,
      type: f.type || "",
      lifecycle: f.lifecycle || "",
      reason: `伏笔与回收表.md 匹配，状态为 ${f.status}`,
    }));
  }

  // character_states（从剧情汇总序列化）
  const charStates = buildCharacterStates(project.path, summaries, lastChapterNum);
  if (Object.keys(charStates).length > 0) {
    L1.character_states = charStates;
  }

  // outline_for_chapter（目标章的大纲）
  if (olText && targetChapter > 0 && !allDone) {
    const targetOutline = parseOutlineChapter(olText, targetChapter);
    if (targetOutline) {
      L1.outline_for_chapter = {
        chapter: targetChapter,
        ...targetOutline,
        reason: `由 ${path.basename(outlinePath)} 第${targetChapter}章提取`,
      };
    }
  }

  // style_reminders
  for (const styleFile of ["文风指导文档.md", "文风控制规范.md", "写作格式规范.md", "重复用词观察表.md"]) {
    const sf = path.join(project.path, styleFile);
    if (fs.existsSync(sf)) {
      const sfText = fs.readFileSync(sf, "utf-8");
      const reminders = sfText.match(/[-•]\s*.{5,80}(?:标签|重复|避免|注意|控制).+/g);
      if (reminders && reminders.length > 0) {
        L1.style_reminders = reminders.slice(0, 5).map(r => ({
          value: r.trim(),
          reason: `${styleFile} 匹配`,
        }));
      }
      break;
    }
  }

  // character_bounds（主角设定集锚标记提取）
  const charBounds = parseCharacterBounds(project.path);
  if (Object.keys(charBounds).length > 0) {
    L1.character_bounds = charBounds;
  }

  // ═══ L2：指针层 ═══
  const L2 = {
    available_data: {
      chapters_range: chapters.length > 0 ? `第1-${chapters.length}章（${archived.length}章已归档）` : "暂无章节",
      foreshadows_total: foreshadows.length,
      foreshadows_resolved: foreshadows.filter(f => f.status === "已回收").length,
      outline_volumes: olText ? [path.basename(outlinePath).replace(/\.md$/, "")] : [],
    },
    suggested_queries: [],
  };

  if (active.length > 0) {
    L2.suggested_queries.push("查询伏笔完整推进轨迹：调 query-novel-state full 模式，查看 active_foreshadows 详情");
  }
  if (Object.keys(charStates).length >= 2) {
    L2.suggested_queries.push("查询角色弧线：调 query-novel-state full 模式，查看 character_timeline");
  }
  if (archived.length >= 3) {
    L2.suggested_queries.push("查询前文章节上下文：调 query-novel-state full 模式，指定章节号");
  }
  L2.suggested_queries.push("检测情感节奏：调 detect-emotion-pattern 对比相邻两章");

  // l2_index（锚点标记索引）
  const l2Index = buildL2Index(project.path);
  if (l2Index.length > 0) {
    L2.anchors = l2Index;
  }

  // ═══ 组装 ═══
  const brief = {
    mode: "brief",
    novel: project.name,
    last_chapter: lastChapterNum,
    target_chapter: allDone ? null : targetChapter,
    status: allDone ? "已完结" : "连载中",
  };

  if (Object.keys(L0).length > 0) brief.L0 = L0;
  if (Object.keys(L1).length > 0) brief.L1 = L1;
  if (Object.keys(L2).length > 0) brief.L2 = L2;

  return brief;
}

// ─── 工具入口 ───
export const name = "query-novel-state";
export const description = "查询指定小说的完整状态（章节进度、伏笔状态、剧情汇总、角色信息）。brief 模式返回 L0/L1/L2 三层上下文——L0 核心写前必读、L1 按章过滤的关联上下文、L2 深查指针。Agent 在写新章节前应调用 brief 模式了解上下文。";

export const parameters = {
  type: "object",
  properties: {
    slug: {
      type: "string",
      description: "小说的 slug（文件夹名拼音化）。不填则列出所有小说。",
    },
    mode: {
      type: "string",
      description: "输出模式：'full' 返回全部数据，'brief' 返回续写简报（精炼版，含 Strand Weave 节奏分析）",
      enum: ["full", "brief"],
      default: "full",
    },
  },
  required: [],
};

export async function execute(input, ctx) {
  const basePath = (ctx.config && ctx.config.novelBasePath) || "";
  if (!basePath) {
    return JSON.stringify({ error: "novelBasePath 未配置，请在插件设置中填写小说项目根目录路径。" }, null, 2);
  }
  const slug = input.slug || "";

  // 发现项目
  const projects = [];
  if (fs.existsSync(basePath)) {
    for (const e of fs.readdirSync(basePath, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sp = path.join(basePath, e.name);
      if (!fs.existsSync(path.join(sp, "章节规划.md"))) continue;
      const name = e.name.replace(/^《|》$/g, "");
      projects.push({ name, slug: slugify(e.name), path: sp });
    }
  }

  if (!slug) {
    return { content: [{ type: "text", text: JSON.stringify(projects.map(p => ({ slug: p.slug, name: p.name })), null, 2) }] };
  }

  const project = projects.find(p => p.slug === slug);
  if (!project) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `未找到小说 '${slug}'，可用: ${projects.map(p => p.slug).join(", ")}` }) }] };
  }

  const chapters = parseChapterPlan(path.join(project.path, "章节规划.md"));
  const foreshadows = parseForeshadowing(path.join(project.path, "伏笔与回收表.md"));
  const summaries = parseSummary(path.join(project.path, "剧情汇总.md"));

  // 合并后续章节上下文
  const mergedChapters = chapters.map((ch, idx) => {
    const s = summaries.find(s => s.chapter_number === ch.chapter_number);
    const prev3 = chapters.slice(Math.max(0, idx - 3), idx).reverse().map(pch => {
      const ps = summaries.find(s => s.chapter_number === pch.chapter_number);
      return { chapter_number: pch.chapter_number, summary: ps?.what?.slice(0, 100) || "" };
    });
    return { chapter_number: ch.chapter_number, status: ch.status, notes: ch.notes, what: s?.what || "", emotion: s?.emotion || "", relation: s?.relation || "", foreshadow_refs: s?.foreshadow || "", setting: s?.setting || "", prev_context: prev3 };
  });

  const result = {
    novel: project.name,
    total_chapters: chapters.length,
    archived: chapters.filter(c => c.status === "已归档").length,
    active_foreshadows: foreshadows.filter(f => f.status === "已埋下" || f.status === "推进中").map(f => ({ id: f.id, content: f.content, status: f.status })),
    resolved_foreshadows: foreshadows.filter(f => f.status === "已回收").map(f => ({ id: f.id, content: f.content })),
    chapters: mergedChapters,
  };

  // 简报模式
  if (input.mode === "brief") {
    const brief = buildBrief(project, chapters, foreshadows, summaries);
    return { content: [{ type: "text", text: JSON.stringify(brief, null, 2) }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
