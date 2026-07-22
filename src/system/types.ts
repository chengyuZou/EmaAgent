/** V1 发布开关；false 表示对应功能暂不向用户开放。 */
export interface ReleaseFeaturesWire {
  readonly artifacts: boolean;
}

/** GET /api/system/capabilities 的响应。 */
export interface AppCapabilitiesWire {
  readonly release: 'v1';
  readonly features: ReleaseFeaturesWire;
}
