// 保存每个 Session 已明确批准的精确请求指纹，并在 Session 结束时整体撤销。
export class SessionGrantStore {
  private readonly grantsBySession = new Map<string, Set<string>>();

  has(sessionId: string | undefined, requestFingerprint: string): boolean {
    if (!sessionId) return false;
    return this.grantsBySession.get(sessionId)?.has(requestFingerprint) ?? false;
  }

  allow(sessionId: string, requestFingerprint: string): void {
    let grants = this.grantsBySession.get(sessionId);
    if (!grants) {
      grants = new Set<string>();
      this.grantsBySession.set(sessionId, grants);
    }
    grants.add(requestFingerprint);
  }

  clear(sessionId: string): void {
    this.grantsBySession.delete(sessionId);
  }
}
