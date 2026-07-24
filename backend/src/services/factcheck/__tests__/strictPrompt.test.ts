import { describe, it, expect } from 'vitest';
import { GroqFactCheckService } from '../GroqFactCheckService';

describe('strict fact-check prompt', () => {
  it('strict prompt forbids own-knowledge verification', () => {
    const strict = (GroqFactCheckService as any).SYSTEM_PROMPT_STRICT as string;
    expect(strict).toContain('ONLY source of truth');
    expect(strict).toContain('unverifiable');
    expect(strict).not.toContain('evaluate using your own knowledge');
  });

  it('external prompt still allows own-knowledge fallback', () => {
    const external = (GroqFactCheckService as any).SYSTEM_PROMPT as string;
    expect(external).toContain('evaluate using your own knowledge');
  });
});
