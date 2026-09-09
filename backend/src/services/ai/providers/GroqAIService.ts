import Groq from 'groq-sdk';
import {
  IAIService,
  AIMessage,
  AIResponse,
  AIContext,
  Intent,
  StreamChunk,
  AIServiceConfig
} from '../types';
import { retryWithBackoff } from '../../../utils/retry';
import { AI_SERVICE } from '../../../config/constants';

/**
 * Groq AI Service Implementation
 * Uses Groq's ultra-fast inference API with Llama models
 * Primarily used for emotional filtering due to low latency
 */
export class GroqAIService implements IAIService {
  private client: Groq;
  private config: AIServiceConfig;
  private model: string;

  constructor(config: AIServiceConfig) {
    if (!config.apiKey) {
      throw new Error('Groq API key is required');
    }

    this.config = config;
    this.client = new Groq({ apiKey: config.apiKey });
    // Default to llama-3.1-8b-instant for fast emotional filtering
    this.model = config.model || 'llama-3.1-8b-instant';
  }

  /**
   * Convert our AIMessage format to Groq's format
   */
  private convertMessages(messages: AIMessage[], systemPrompt?: string): Groq.Chat.ChatCompletionMessageParam[] {
    const groqMessages: Groq.Chat.ChatCompletionMessageParam[] = [];

    // Add system prompt if provided
    if (systemPrompt) {
      groqMessages.push({
        role: 'system',
        content: systemPrompt
      });
    }

    // Convert messages
    for (const message of messages) {
      if (message.role === 'system') {
        groqMessages.push({
          role: 'system',
          content: message.content
        });
      } else if (message.role === 'user') {
        groqMessages.push({
          role: 'user',
          content: message.content
        });
      } else if (message.role === 'assistant') {
        groqMessages.push({
          role: 'assistant',
          content: message.content
        });
      }
    }

    return groqMessages;
  }

  /**
   * Build context string from AIContext
   */
  private buildContextString(context: AIContext): string {
    const parts: string[] = [];

    if (context.courseMetadata) {
      parts.push(`Course: ${context.courseMetadata.title || 'Unknown'}`);
    }

    if (context.studentContext) {
      parts.push(`Student Context: ${JSON.stringify(context.studentContext)}`);
    }

    return parts.join('\n');
  }

  async generateResponse(
    messages: AIMessage[],
    context: AIContext,
    systemPrompt?: string,
    options?: { jsonMode?: boolean }
  ): Promise<AIResponse> {
    try {
      // Build context information
      const contextString = this.buildContextString(context);

      // Combine system prompt with context
      let fullSystemPrompt = systemPrompt
        ? `${systemPrompt}\n\n**Context:**\n${contextString}`
        : contextString ? `**Context:**\n${contextString}` : undefined;

      // Add JSON mode instruction if requested
      if (options?.jsonMode) {
        fullSystemPrompt = (fullSystemPrompt || '') +
          '\n\nCRITICAL: Respond with ONLY valid JSON. No markdown, no explanations, just the JSON object.';
      }

      // Convert messages to Groq format
      const groqMessages = this.convertMessages(messages, fullSystemPrompt);

      // Generate response with retry logic
      const result = await retryWithBackoff(
        async () => {
          return await this.client.chat.completions.create({
            messages: groqMessages,
            model: this.model,
            temperature: this.config.temperature || 0.7,
            max_tokens: this.config.maxTokens || 1024,
            response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
            // ponytail: reasoning models (qwen3, gpt-oss) blow json_object mode by emitting <think> tokens; disable thinking. Omitted (undefined) for llama.
            reasoning_effort: /qwen|gpt-oss/.test(this.model) ? 'none' : undefined
          });
        },
        {
          maxRetries: AI_SERVICE.MAX_RETRIES,
          initialDelayMs: AI_SERVICE.INITIAL_RETRY_DELAY_MS,
          maxDelayMs: AI_SERVICE.MAX_RETRY_DELAY_MS,
          onRetry: (error, attempt) => {
            console.warn(`🔄 Groq API retry attempt ${attempt}:`, error.message);
          },
        }
      );

      const text = result.choices[0]?.message?.content || '';

      // Calculate confidence based on response characteristics
      const confidence = await this.calculateConfidence(text, context);

      const aiResponse: AIResponse = {
        content: text,
        confidence,
        requiresReview: false,
        metadata: {
          model: this.model,
          usage: result.usage
        }
      };

      return aiResponse;
    } catch (error: any) {
      console.error('Groq API Error:', error);
      throw new Error(`Failed to generate response: ${error.message}`);
    }
  }

  async *streamResponse(
    messages: AIMessage[],
    context: AIContext,
    systemPrompt?: string
  ): AsyncGenerator<StreamChunk> {
    try {
      const contextString = this.buildContextString(context);
      const fullSystemPrompt = systemPrompt
        ? `${systemPrompt}\n\n**Context:**\n${contextString}`
        : contextString ? `**Context:**\n${contextString}` : undefined;

      const groqMessages = this.convertMessages(messages, fullSystemPrompt);

      const stream = await this.client.chat.completions.create({
        messages: groqMessages,
        model: this.model,
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.maxTokens || 1024,
        stream: true
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        const isComplete = chunk.choices[0]?.finish_reason === 'stop';

        yield {
          content,
          isComplete
        };
      }
    } catch (error: any) {
      console.error('Groq Streaming Error:', error);
      throw new Error(`Failed to stream response: ${error.message}`);
    }
  }

  async analyzeIntent(message: string): Promise<Intent> {
    try {
      const prompt = `Analyze the student message and classify the intent.
Categories: QUIZ_GENERATION, CONCEPT_EXPLANATION, ASSIGNMENT_QUERY, GRADE_INQUIRY, HELP_REQUEST, SUMMARY_REQUEST, STUDY_PLAN, DIRECT_ANSWER_REQUEST, GENERAL_QUESTION

Return JSON: {"type": "INTENT_TYPE", "topic": "topic if applicable", "confidence": 0.0-1.0}

Message: "${message}"`;

      const result = await this.client.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: this.model,
        temperature: 0.3,
        max_tokens: 150,
        response_format: { type: 'json_object' }
      });

      const text = result.choices[0]?.message?.content || '{}';
      const intent = JSON.parse(text);

      return {
        type: intent.type || 'GENERAL_QUESTION',
        topic: intent.topic,
        confidence: intent.confidence || 0.7
      };
    } catch (error: any) {
      console.error('Intent analysis error:', error);
      return { type: 'GENERAL_QUESTION', confidence: 0.5 };
    }
  }

  async calculateConfidence(response: string, context: AIContext): Promise<number> {
    let confidence = 0.7;

    if (context.relevantMaterials && context.relevantMaterials.length > 0) {
      confidence += 0.15;
    }

    const uncertainWords = ['might', 'maybe', 'possibly', 'i think', 'not sure'];
    if (uncertainWords.some(word => response.toLowerCase().includes(word))) {
      confidence -= 0.2;
    }

    if (response.length > 200) {
      confidence += 0.1;
    }

    return Math.max(0.1, Math.min(1, confidence));
  }

  async shouldRequireReview(response: AIResponse, context: AIContext): Promise<boolean> {
    return response.confidence < 0.6;
  }
}
