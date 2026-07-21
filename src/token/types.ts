export type TokenEstimateAccuracy = 'heuristic' | 'modelAware' | 'providerExact';

export type TokenEstimateWarningCode =
  | 'imageDimensionsUnknown'
  | 'audioDurationUnknown'
  | 'documentPageCountUnknown'
  | 'toolDefinitionSerializationFailed';

export interface TokenEstimateBreakdown {
  textTokens: number;
  messageEnvelopeTokens: number;
  toolDefinitionTokens: number;
  imageTokens: number;
  audioTokens: number;
  documentTokens: number;
  otherTokens: number;
}

export interface TokenEstimate {
  totalTokens: number;
  accuracy: TokenEstimateAccuracy;
  breakdown: TokenEstimateBreakdown;
  warnings: TokenEstimateWarningCode[];
}

export interface TokenToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TokenEstimateOptions {
  tools?: readonly TokenToolDefinition[];
}
