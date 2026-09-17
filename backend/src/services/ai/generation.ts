/** Generation-only contract: deliberately independent of grading/confidence APIs. */
export interface GenerationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface GenerationRequest {
  messages: GenerationMessage[];
  signal?: AbortSignal;
}
export interface GenerationResult {
  content: string;
  provider: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}
export interface GenerationProvider {
  generate(request: GenerationRequest): Promise<GenerationResult>;
}
