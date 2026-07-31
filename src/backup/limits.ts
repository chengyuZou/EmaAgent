// 备份导入导出的集中安全上限,编解码、归档与文件复制共用同一口径。

export const BACKUP_LIMITS = Object.freeze({
  // ── 归档输入(不可信)──
  /** 压缩包体积上限；流式解压可以放大，但仍必须有顶。 */
  maxArchiveBytes: 2 * 1024 ** 3,
  /** 条目数上限,防条目炸弹。 */
  maxEntries: 100_000,
  /** 单条目展开上限。 */
  maxEntryBytes: 2 * 1024 ** 3,
  /** 全条目展开总上限。 */
  maxExpandedBytes: 8 * 1024 ** 3,
  /** 压缩比上限,防 zip bomb。 */
  maxCompressionRatio: 500,

  // ── JSONL 编解码 ──
  /** 单行字节上限,防单行巨型炸弹撑爆逐行解析。 */
  jsonlMaxLineBytes: 8 * 1024 ** 2,
  /** 全部记录文件的累计行数上限:多个单文件上限叠加也不能失控。 */
  maxTotalRecords: 2_000_000,

  // ── 单个二进制文件(附件/音频/后台输出)──
  maxAttachmentBytes: 2 * 1024 ** 3,
  maxAudioBytes: 64 * 1024 ** 2,
  /** 后台输出单流 16MB,双流加余量。 */
  maxBackgroundOutputBytes: 64 * 1024 ** 2,

  // ── 导出分页 ──
  /** 只读事务内逐页读取的页大小,只限制内存驻留,不承担缩短事务的作用。 */
  exportPageSize: 500,
});

export type BackupLimits = typeof BACKUP_LIMITS;
