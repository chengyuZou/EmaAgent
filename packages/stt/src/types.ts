import type { SttRequest, SttResponse, SttProtocol } from '@ema-agent/contracts';

export type { SttRequest, SttResponse, SttProtocol } from '@ema-agent/contracts';

export interface SttProviderConfig {
  id:       string;
  protocol: SttProtocol;
  apiKey:   string;
  baseUrl:  string;
}

export interface SttAdapter {
  readonly protocol: SttProtocol;
  transcribe(req: SttRequest, model: string): Promise<SttResponse>;
}
