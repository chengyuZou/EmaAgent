import {
  createWriteStream, lstatSync, mkdirSync, readdirSync, unlinkSync,
  type Stats, type WriteStream,
} from 'node:fs';
import path from 'node:path';
import { createLogRow } from './internal/record.js';
import { redactLogRow } from './internal/redact.js';
import { encodeLogWithinLimit, MAX_LOG_BYTES } from './internal/limit.js';

// 单个日志文件的体积上限
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
// 所有日志文件占用的总空间上限
const MAX_RETAINED_LOG_BYTES = 100 * 1024 * 1024;
// 日志文件的保留时长
const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
// 文件流达到这个缓冲阈值后要求暂停提交, 不是内存占用的硬上限.
const WRITE_BUFFER_THRESHOLD_BYTES = 64 * 1024;

// 本进程尚未关闭的日志路径. 轮换期间新旧文件都在其中, 清理时不能删除.
const openLogFilePaths = new Set<string>();
let nextFileSequence = 0;

interface OpenLogFile {
  readonly filePath: string;
  /** Node 的文件追加写入流, 接受正文并发出 drain, error 和 close 事件. */
  readonly writeStream: WriteStream;
  /** 该文件累计接受的 UTF-8 字节数, 包括还在缓冲中的数据, 不表示已经落盘. */
  acceptedBytes: number;
}

interface RetainedLogFile {
  filePath: string;
  /** 计入容量预算的字节数, 取磁盘大小与本进程已接受字节数中的较大值. */
  countedBytes: number;
  /** 文件最后修改时间的 Unix 毫秒数, 用来判断保留期限. */
  modifiedAtMs: number;
  /** 从文件名解析出的创建者 PID, 用来避开其他仍在运行的写入进程. */
  ownerPid: number;
}

export class FileLogWriter {
  /** 当前接收新日志的文件. 尚未创建写入流时为 undefined. */
  private currentLogFile: OpenLogFile | undefined;
  /** 尚未收到 close 事件的文件, 包含当前文件和轮换后正在收尾的旧文件. */
  private readonly openLogFiles = new Set<OpenLogFile>();
  /** close() 等待全部文件关闭时登记的检查函数, 完成或超时后移除. 不保存日志正文. */
  private readonly closeCompletionChecks = new Set<() => void>();
  /** 最近清理扫描的总量加上后续接受的写入, 用于容量判断, 不是实时磁盘使用量. */
  private totalLogBytes = 0;
  /** 已丢弃但尚未写入统计说明的条数, 不保留被丢弃的正文. */
  private unreportedDroppedCount = 0;
  /** 创建, 写入, 容量检查或关闭失败后停止接收, close() 必须返回失败. */
  private writeFailed = false;
  /** 正在正常收尾: 拒绝新日志, 等待已经接受的数据写完并关闭文件. */
  private closing = false;
  /** 本写入者管理的日志目录, 保存为绝对路径. */
  private readonly logDirectory: string;
  /** 写入者创建时的 Unix 毫秒数, 与 PID 和序号一起组成文件名. */
  private readonly startedAtMs = Date.now();

  constructor(logDirectory: string) {
    this.logDirectory = path.resolve(logDirectory);
    try {
      mkdirSync(this.logDirectory, { recursive: true });
      this.openNextLogFile();
    } catch (error) {
      this.stopAfterFileFailure(error);
    }
  }

  /** 提交已经格式化, 脱敏和限长的 JSON 日志行. 不等待写盘, 拥堵时只统计丢弃条数. */
  write(line: string): void {
    if (this.writeFailed || this.closing || !this.currentLogFile) return;
    if (!this.tryAppendLine(line)) {
      // TODO: 为拥堵时丢弃的日志提供可恢复交付. 当前只计数, 文件恢复写入后不能补回正文.
      this.unreportedDroppedCount += 1;
    }
  }

  /** true 只表示文件流接受了这一行, 不表示异步写入或 fsync 已经完成. */
  private tryAppendLine(line: string): boolean {
    let logFile = this.currentLogFile;
    if (!logFile) return false;
    // 上一次 write 已要求暂停提交, 这一行尚未交给文件流.
    if (logFile.writeStream.writableNeedDrain) return false;

    const lineBytes = Buffer.byteLength(line, 'utf8');
    const needsNextFile = logFile.acceptedBytes + lineBytes > MAX_LOG_FILE_BYTES - MAX_LOG_BYTES;
    // 上一个文件还没关闭时不再继续轮换, 避免积累越来越多的打开文件和缓冲.
    if (needsNextFile && this.openLogFiles.size > 1) return false;
    try {
      // 为关闭时的一条丢弃统计留出空间, 即使当前流拥堵也能在 end 时一起提交.
      if (needsNextFile) logFile = this.openNextLogFile();
      if (this.totalLogBytes + lineBytes > MAX_RETAINED_LOG_BYTES - MAX_LOG_BYTES) {
        this.cleanupOldLogs(lineBytes + MAX_LOG_BYTES);
      }
      // Node write 返回 false 时本条也已接受. 照常计入字节数, 下一条才等待 drain.
      logFile.writeStream.write(line, 'utf8');
      logFile.acceptedBytes += lineBytes;
      this.totalLogBytes += lineBytes;
      return true;
    } catch (error) {
      this.stopAfterFileFailure(error);
      return false;
    }
  }

  /** 停止接收, 等已接受的写入完成并同步关闭文件. 超时返回 false, 不声称日志已经保存. */
  async close(timeoutMs = 2_000): Promise<boolean> {
    if (!this.closing) {
      this.closing = true;
      const summary = this.unreportedDroppedCount
        ? this.createDroppedCountLine(this.unreportedDroppedCount)
        : '';
      this.unreportedDroppedCount = 0;
      for (const logFile of this.openLogFiles) {
        const { writeStream } = logFile;
        // end() 是停止接收并开始收尾, 要等 close 事件才能确认文件描述符已关闭.
        if (!writeStream.writableEnded && !writeStream.destroyed) {
          writeStream.end(logFile === this.currentLogFile ? summary : '', 'utf8');
        }
      }
    }
    if (this.openLogFiles.size === 0) return !this.writeFailed;
    return new Promise(resolve => {
      const finish = (success: boolean): void => {
        clearTimeout(deadline);
        this.closeCompletionChecks.delete(check);
        resolve(success);
      };
      const check = (): void => {
        if (this.openLogFiles.size === 0) finish(!this.writeFailed);
      };
      const deadline = setTimeout(() => {
        // TODO: 卡在系统 I/O 的写入还不能独立重启. 当前限时返回失败, 由进程退出回收句柄.
        this.stopAfterFileFailure(new Error('Log files did not finish closing before the deadline.'));
        finish(false);
      }, timeoutMs);
      this.closeCompletionChecks.add(check);
      check();
    });
  }

  /**
   * 创建第一个或下一个日志文件, 此后的新日志写入它.
   * 旧文件只发起 end(), 收到 close 事件后才从打开列表移除, 避免被提前清理.
   */
  private openNextLogFile(): OpenLogFile {
    this.cleanupOldLogs(0);
    const filename = `ema-${this.startedAtMs}-${process.pid}-${nextFileSequence++}.log`;
    const filePath = path.join(this.logDirectory, filename);
    const previousFile = this.currentLogFile;
    const writeStream = createWriteStream(filePath, {
      // 追加写入; 同名文件已经存在时失败, 不覆盖它.
      flags: 'ax',
      mode: 0o600,
      encoding: 'utf8',
      highWaterMark: WRITE_BUFFER_THRESHOLD_BYTES,
      // Node 在 close 前调用 fsync. 普通 write 完成仍不等于能抵抗突然断电.
      flush: true,
    });
    const logFile: OpenLogFile = { filePath, writeStream, acceptedBytes: 0 };
    openLogFilePaths.add(filePath);
    this.openLogFiles.add(logFile);
    this.currentLogFile = logFile;
    writeStream.on('error', error => this.stopAfterFileFailure(error));
    writeStream.on('drain', () => {
      // drain 表示之前的拥堵已解除, 可以继续提交, 不表示文件已经同步到磁盘.
      if (this.currentLogFile === logFile) this.reportDroppedCount();
    });
    writeStream.once('close', () => {
      openLogFilePaths.delete(filePath);
      this.openLogFiles.delete(logFile);
      for (const checkCloseCompletion of this.closeCompletionChecks) {
        checkCloseCompletion();
      }
      this.reportDroppedCount();
    });
    previousFile?.writeStream.end();
    return logFile;
  }

  /** 恢复写入后只报告丢弃条数, 不会重新发送已经丢弃的正文. */
  private reportDroppedCount(): void {
    if (!this.unreportedDroppedCount || this.writeFailed || this.closing) return;
    if (!this.currentLogFile || this.currentLogFile.writeStream.writableNeedDrain) return;
    const count = this.unreportedDroppedCount;
    if (this.tryAppendLine(this.createDroppedCountLine(count))) {
      this.unreportedDroppedCount -= count;
    }
  }

  private createDroppedCountLine(count: number): string {
    return encodeLogWithinLimit(createLogRow({
      level: 'warn',
      target: 'logging',
      event: 'logging.dropped',
      body: { count },
    }));
  }

  /** 真正的文件失败会停止接收并销毁流; 关闭结果不能再报告保存成功. */
  private stopAfterFileFailure(error: unknown): void {
    if (this.writeFailed) return;
    this.writeFailed = true;
    for (const logFile of this.openLogFiles) logFile.writeStream.destroy();
    // 文件写入失败时只向 Node stderr 报告一次, 不再递归调用 logging.
    writeToStderr(encodeLogWithinLimit(redactLogRow(createLogRow({
      level: 'error',
      target: 'logging',
      event: 'logging.file_failed',
      error,
    }))));
  }

  /**
   * 删除过期或超出保留预算的已关闭日志, 同时更新日志总量.
   * bytesToReserve 是下一次写入及结束统计需要预留的字节数, 不是文件条数或磁盘剩余空间.
   * 传 0 仍会清理过期文件. 无法腾出要求的容量时抛错, 由调用方停止写入.
   */
  private cleanupOldLogs(bytesToReserve: number): void {
    const files: RetainedLogFile[] = [];
    const countedPaths = new Set<string>();
    const acceptedBytesByPath = new Map(
      [...this.openLogFiles].map(file => [file.filePath, file.acceptedBytes]),
    );
    let totalLogBytes = 0;
    for (const entry of readdirSync(this.logDirectory, { withFileTypes: true })) {
      const match = /^ema-\d+-(\d+)(?:-\d+)?\.log$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const filePath = path.join(this.logDirectory, entry.name);
      let metadata: Stats;
      try {
        metadata = lstatSync(filePath);
      } catch (error) {
        // 目录枚举不是快照, 另一进程可能已经删除这份旧日志. 其他错误不能伪装成文件不存在.
        if (isMissingFile(error)) continue;
        throw error;
      }
      // 流已接受的字节可能还没出现在磁盘大小中, 容量预算不能漏掉这部分.
      const countedBytes = Math.max(metadata.size, acceptedBytesByPath.get(filePath) ?? 0);
      totalLogBytes += countedBytes;
      countedPaths.add(filePath);
      files.push({
        filePath,
        countedBytes,
        modifiedAtMs: metadata.mtimeMs,
        ownerPid: Number(match[1]),
      });
    }
    // createWriteStream 可能还没完成文件创建, 这些已接受数据同样需要计入预算.
    for (const file of this.openLogFiles) {
      if (!countedPaths.has(file.filePath)) totalLogBytes += file.acceptedBytes;
    }
    files.sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
    const expiredBeforeMs = Date.now() - LOG_RETENTION_MS;
    for (const file of files) {
      if (file.modifiedAtMs >= expiredBeforeMs && totalLogBytes + bytesToReserve <= MAX_RETAINED_LOG_BYTES) {
        continue;
      }
      if (openLogFilePaths.has(file.filePath) || isOtherLogProcessRunning(file.ownerPid)) continue;
      try {
        unlinkSync(file.filePath);
      } catch (error) {
        // 其他进程已删掉时也要扣除占用. 权限或占用导致的删除失败仍按文件存在计算.
        if (!isMissingFile(error)) continue;
      }
      totalLogBytes -= file.countedBytes;
    }
    this.totalLogBytes = totalLogBytes;
    if (totalLogBytes + bytesToReserve > MAX_RETAINED_LOG_BYTES) {
      throw new Error('Log directory limit reached; old logs could not be removed.');
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isOtherLogProcessRunning(pid: number): boolean {
  // 本进程由 openLogFilePaths 区分打开与已关闭的文件, 不能因为 PID 相同就全部保留.
  if (pid === process.pid) return false;
  try {
    // 信号 0 只检查进程是否存在和能否查询, 不会结束进程.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 没权限查询时保守保留, 只删除已确认进程不存在的旧文件.
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

function writeToStderr(line: string): void {
  if (process.stderr.destroyed || process.stderr.writableNeedDrain) return;
  const onError = (): void => {};
  process.stderr.once('error', onError);
  try {
    process.stderr.write(line, 'utf8', error => {
      if (!error) process.stderr.off('error', onError);
    });
  } catch {
    process.stderr.off('error', onError);
  }
}

let writer: FileLogWriter | undefined;

/** 应在业务包启动前调用. 目录由 Server 提供, 日志包不依赖 Storage 或用户数据库. */
export function initializeLogging(logDirectory: string): void {
  if (writer) throw new Error('Logging is already initialized.');
  writer = new FileLogWriter(logDirectory);
}

export function writeLogLine(line: string): void {
  if (writer) writer.write(line);
  else writeToStderr(line);
}

/** 正常退出前调用; 未初始化时没有日志文件需要关闭. */
export function closeLogging(timeoutMs = 2_000): Promise<boolean> {
  return writer?.close(timeoutMs) ?? Promise.resolve(true);
}
