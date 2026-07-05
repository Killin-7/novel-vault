/**
 * novel-vault — 入口
 * Markdown 原生解析 + 插件私有 JSON 存储
 */
import { initDb, upsertNovel } from "./lib/store.js";
import fs from "fs";
import path from "path";

function slugify(s) { return s.replace(/[^\w\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "novel"; }

export default class NovelVaultPlugin {
  async onload() {
    initDb(this.ctx.dataDir);
    
    // 自动同步文件系统中的小说到 store
    const config = this.ctx.config || {};
    const basePath = config.novelBasePath || "";
    try {
      if (basePath && fs.existsSync(basePath)) {
        for (const e of fs.readdirSync(basePath, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const sp = path.join(basePath, e.name);
          if (!fs.existsSync(path.join(sp, "章节规划.md"))) continue;
          const name = e.name.replace(/^《|》$/g, "");
          upsertNovel({ slug: slugify(e.name), title: name, path: sp });
        }
      }
    } catch(e) {
      this.ctx.log.warn("[novel-vault] novel sync failed: " + e.message);
    }
    
    this.ctx.log.info("[novel-vault] ready (markdown-native mode)");
  }

  async onunload() {
    this.ctx.log.info("[novel-vault] closing");
  }
}
