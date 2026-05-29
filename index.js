/**
 * novel-vault — 入口
 * Markdown 原生解析模式（无需额外数据库）
 */
export default class NovelVaultPlugin {
  async onload() {
    this.ctx.log.info("[novel-vault] ready (markdown-native mode)");
  }

  async onunload() {
    this.ctx.log.info("[novel-vault] closing");
  }
}
