import { SimpleBaseAgent, AgentMetadata, AgentMessage, AgentResponse, ResponseSource } from './newAgentTypes';
import { AIContext, AIMessage, AIResponse } from '../ai/types';
import { getAIService } from '../ai/AIServiceFactory';
import { pool } from '../../config/database';
import { WebSearchService } from '../search/WebSearchService';
import { searchCourseMaterials as vectorSearchCourseMaterials, getCourseMaterialStats } from '../vectorSearch';
import { AGENT_CONFIG, VECTOR_SEARCH, EMOTIONAL_FILTER_CONFIG, RERANKER_CONFIG } from '../../config/constants';
import { rerank } from '../rerankerService';
import { getEmotionalFilterService, EmotionalFilterResult } from '../emotional/EmotionalFilterService';
import { downloadFile } from '../../config/storage';
import { extractTextFromFile } from '../documentProcessor';
import { generateEmbeddings } from '../embeddingService';
import { embeddingToPostgresVector } from '../embeddingService';

/**
 * Subject-Specific Chatbot Agent
 *
 * Purpose: Provides course-specific assistance with mandatory source attribution
 *
 * Requirements:
 * - Full access to all course materials for the specific subject
 * - Every response MUST include source attribution
 * - Source attribution formats:
 *   - Course Materials: File name + Section/Page + Excerpt
 *   - Internet Sources: URL + Source name + Date accessed
 * - Supports quiz generation (integrated from Quiz Master)
 */
export class SubjectChatbotAgent extends SimpleBaseAgent {
  protected metadata: AgentMetadata = {
    name: 'Subject Chatbot',
    type: 'subject_chatbot',
    description: 'Provides course-specific assistance with source attribution for all responses',
    capabilities: [
      'Answer questions about course materials',
      'Explain concepts with citations',
      'Generate practice questions and quizzes',
      'Provide study guidance',
      'Search and reference course materials',
      'Cite internet sources when needed'
    ],
    tools: [
      'searchCourseMaterials',
      'getCourseMaterials',
      'generatePracticeQuestions',
      'explainConcept'
    ],
    systemPrompt: this.getSystemPrompt()
  };

  private getSystemPrompt(): string {
    return `You are a Subject-Specific Chatbot designed to help students learn course material.

Your responsibilities:
1. Answer student questions accurately using course materials as the primary source
2. When course materials are insufficient, use your general knowledge to provide helpful information
3. Provide clear, educational explanations that promote learning
4. Generate practice questions and quizzes when requested
5. Help students understand concepts without giving direct answers to homework
6. **CRITICALLY IMPORTANT: ALWAYS provide source attribution for EVERY response**

SOURCE PRIORITY:
1. **First Priority**: Course materials uploaded by the professor
2. **Second Priority**: Your general knowledge (when explicitly permitted)
3. Be transparent about which source you're using

SOURCE ATTRIBUTION REQUIREMENTS (MANDATORY):
For EVERY piece of information you provide, you MUST cite the source:

**For Course Materials:**
- File name
- Specific section or page number
- Relevant excerpt (if applicable)
- Format: "[Source: {file_name}, Section {section}, Page {page}]"

**For General Knowledge (when course materials are insufficient):**
- Indicate this is general industry knowledge
- Format: "[Source: General industry knowledge]"
- When possible, mention reputable sources like: "Based on industry standards..." or "According to common practices in the field..."

**For Professor's Notes/Lectures:**
- Note title or lecture number
- Date or topic
- Format: "[Source: {lecture/note_title}]"

CRITICAL RULES:
- NEVER provide information without indicating the source
- ALWAYS prefer course materials over general knowledge when both are available
- When no course materials are available, clearly state: "I don't have course materials on this specific topic, but I can provide general information based on industry knowledge."
- Be transparent about the limitation of not having course-specific materials
- When generating quizzes, cite which materials the questions are based on
- Do NOT give direct answers to homework or assignment questions
- Focus on guiding students to understand concepts

RESPONSE FORMAT:
Every response should include:
1. Clear indication of whether you're using course materials or general knowledge
2. The answer/explanation
3. Source citations (inline or at the end)
4. Relevant examples or practice questions (optional)

Example response with course materials:
"Neural networks are composed of interconnected layers of nodes that process information. [Source: Deep Learning Basics.pdf, Section 2.1, Page 15]

The key components include:
- Input layer: Receives the initial data [Source: Deep Learning Basics.pdf, Page 16]
- Hidden layers: Process and transform the data [Source: Deep Learning Basics.pdf, Page 17-18]
- Output layer: Produces the final result [Source: Deep Learning Basics.pdf, Page 19]

Would you like me to generate practice questions on this topic?"

Example response with general knowledge:
"I don't have specific course materials on entry-level Cloud Engineer salaries, but I can provide general information based on industry knowledge.

Entry-level Cloud Engineer salaries typically range from $70,000 to $95,000 annually in the United States, varying by location and company size. [Source: General industry knowledge]

Key factors affecting salary:
- Geographic location (higher in tech hubs like San Francisco, Seattle)
- Company size and type (startups vs. enterprise)
- Specific cloud platform expertise (AWS, Azure, GCP)
- Relevant certifications

[Source: General industry knowledge based on common industry reports and job market data]

Note: For the most current and region-specific information, I recommend checking:
- Glassdoor, LinkedIn Salary, or Payscale for current market rates
- Your university's career services for local market data
- Asking your professor if they have industry connections or course materials on career planning

Would you like me to help you understand what skills and certifications can help maximize your earning potential as a Cloud Engineer?"`;
  }

  /**
   * Assemble the user turn that is actually sent to the model.
   *
   * Course materials are the PRIMARY, authoritative source and are injected
   * directly into the prompt. Web results (when present) are appended as clearly
   * labeled SECONDARY context, to be used only to fill gaps the course materials
   * don't cover. If nothing was retrieved, the plain question is returned and the
   * system prompt's general-knowledge fallback applies.
   */
  private buildGroundedQuestion(
    question: string,
    materials: CourseMaterial[],
    webResults: any[]
  ): string {
    const hasMaterials = Array.isArray(materials) && materials.length > 0;
    const hasWeb = Array.isArray(webResults) && webResults.length > 0;

    if (!hasMaterials && !hasWeb) {
      return question;
    }

    const parts: string[] = [];

    if (hasMaterials) {
      // Inject only the top-N most relevant chunks (already sorted best-first by the
      // vector search), each truncated, to stay within the model's token budget.
      const top = materials.slice(0, AGENT_CONFIG.CHATBOT_PROMPT_MAX_CHUNKS);
      const block = top
        .map((m, i) => {
          const page = m.page_number ? `, Page ${m.page_number}` : '';
          const sim = typeof m.similarity_score === 'number'
            ? ` (relevance ${m.similarity_score.toFixed(2)})`
            : '';
          let excerpt = (m.content_text || '').trim();
          if (excerpt.length > AGENT_CONFIG.CHATBOT_PROMPT_MAX_CHARS_PER_CHUNK) {
            excerpt = excerpt.slice(0, AGENT_CONFIG.CHATBOT_PROMPT_MAX_CHARS_PER_CHUNK) + '…';
          }
          return `[${i + 1}] ${m.file_name}${page}${sim}\n${excerpt}`;
        })
        .join('\n\n');

      parts.push(
        `===== COURSE MATERIALS (PRIMARY SOURCE) =====\n${block}\n===== END COURSE MATERIALS =====`
      );
    }

    if (hasWeb) {
      parts.push(
        `===== SECONDARY SOURCES (WEB — use ONLY to fill gaps the course materials don't cover) =====\n` +
        `${WebSearchService.formatResultsForAI(webResults)}\n===== END SECONDARY SOURCES =====`
      );
    }

    const rules = hasMaterials
      ? `INSTRUCTIONS:
- Answer the student's question using the COURSE MATERIALS above as the PRIMARY and authoritative source.
- Cite each fact taken from them as [Source: {file_name}, Page {page}] using the names shown above.
- Only if the course materials do NOT contain the answer, say so explicitly, then you may use the SECONDARY sources or your general knowledge — and label those clearly as "[Source: General knowledge]" or the web URL.
- Do NOT invent file names or attribute information to course materials that is not in the excerpts above.`
      : `INSTRUCTIONS:
- The course materials do not cover this question. Tell the student that, then answer using the SECONDARY sources / your general knowledge, clearly labeled "[Source: General knowledge]" or the web URL.`;

    parts.push(rules);
    parts.push(`STUDENT QUESTION: ${question}`);

    return parts.join('\n\n');
  }

  /**
   * Process a student question and generate response with sources
   */
  async execute(message: AgentMessage, context: AIContext): Promise<AgentResponse> {
    const startTime = Date.now();

    try {
      // Extract course ID from context
      const courseId = context.courseMetadata?.id;
      if (!courseId) {
        throw new Error('Course ID is required for Subject Chatbot');
      }

      // Search for relevant course materials using vector search
      const relevantMaterials = await this.searchCourseMaterials(
        courseId,
        message.content,
        AGENT_CONFIG.CHATBOT_SEARCH_LIMIT
      );

      // Stage 2: cross-encoder precision over the vector recall set.
      const rankedMaterials = RERANKER_CONFIG.ENABLED
        ? await rerank(
            message.content,
            relevantMaterials,
            m => m.content_text || '',
            AGENT_CONFIG.CHATBOT_PROMPT_MAX_CHUNKS
          )
        : relevantMaterials;

      // Check if we should search the web (if course materials are insufficient)
      const webSearchService = new WebSearchService();
      const shouldSearchWeb = WebSearchService.shouldSearchWeb(relevantMaterials, message.content);

      let webSearchResults: any[] = [];
      let webSearchContext = '';

      if (shouldSearchWeb) {
        console.log('📡 Course materials insufficient, searching the web...');
        webSearchResults = await webSearchService.searchWithContent(message.content, {
          maxResults: AGENT_CONFIG.WEB_SEARCH_MAX_RESULTS,
          safeSearch: true
        });

        webSearchContext = WebSearchService.formatResultsForAI(webSearchResults);
        console.log(`✅ Found ${webSearchResults.length} web results`);
      }

      // Build enhanced context with course materials AND web search results
      const enhancedContext: AIContext = {
        ...context,
        relevantMaterials: rankedMaterials,
        webSearchResults: webSearchResults.length > 0 ? webSearchResults : undefined
      };

      // Build the grounded user turn. Course materials are injected as the PRIMARY
      // source and web results (if any) as labeled SECONDARY context. Previously the
      // retrieved chunks were never sent to the model, so answers were ungrounded.
      const groundedQuestion = this.buildGroundedQuestion(
        message.content,
        rankedMaterials,
        webSearchResults
      );

      // Build conversation history
      const messages: AIMessage[] = [
        {
          role: 'system',
          content: this.metadata.systemPrompt || ''
        },
        ...context.conversationHistory,
        {
          role: 'user',
          content: groundedQuestion
        }
      ];

      // Generate AI response
      const aiService = getAIService();
      const aiResponse: AIResponse = await aiService.generateResponse(
        messages,
        enhancedContext,
        this.metadata.systemPrompt
      );

      // Apply emotional filter to adjust response tone based on student's emotional state
      let finalContent = aiResponse.content;
      let emotionalFilterResult: EmotionalFilterResult | null = null;

      if (EMOTIONAL_FILTER_CONFIG.ENABLED) {
        try {
          const emotionalFilter = getEmotionalFilterService();

          if (emotionalFilter.isEnabled()) {
            emotionalFilterResult = await emotionalFilter.filterResponse(
              aiResponse.content,
              message.content,
              context.conversationHistory,
              {
                title: context.courseMetadata?.title,
                topic: context.courseMetadata?.description
              }
            );

            finalContent = emotionalFilterResult.adjustedResponse;

            if (emotionalFilterResult.wasAdjusted) {
              console.log(`🎭 Emotional filter applied: ${emotionalFilterResult.emotionalContext.currentState.primary} (${emotionalFilterResult.emotionalContext.currentState.intensity}) → ${emotionalFilterResult.emotionalContext.recommendedTone} tone`);
            }
          }
        } catch (emotionalError: any) {
          console.warn('⚠️ Emotional filter failed, using original response:', emotionalError.message);
          // Continue with original response if emotional filter fails
        }
      }

      // Extract sources from the response (including web sources)
      const sources = this.extractSources(finalContent, rankedMaterials, webSearchResults);

      // Store sources in database
      if (message.sessionId && message.messageId) {
        await this.storeSources(message.messageId, sources);
      }

      // Log the action
      const executionTime = Date.now() - startTime;
      await this.logAgentAction(
        'answer_question',
        message.userId,
        courseId,
        message.sessionId || null,
        { question: message.content, webSearchUsed: shouldSearchWeb },
        {
          answer: finalContent,
          sourcesCount: sources.length,
          webResultsCount: webSearchResults.length,
          emotionalFilterApplied: emotionalFilterResult?.wasAdjusted || false
        },
        aiResponse.confidence || 0.8,
        executionTime
      );

      return {
        content: finalContent,
        confidence: aiResponse.confidence || 0.8,
        requiresReview: aiResponse.requiresReview || false,
        sources: sources,
        metadata: {
          sourcesProvided: sources.length,
          materialsSearched: relevantMaterials.length,
          webSearchUsed: shouldSearchWeb,
          webResultsFound: webSearchResults.length,
          emotionalFilter: emotionalFilterResult ? {
            applied: emotionalFilterResult.wasAdjusted,
            detectedEmotion: emotionalFilterResult.emotionalContext.currentState.primary,
            emotionIntensity: emotionalFilterResult.emotionalContext.currentState.intensity,
            appliedTone: emotionalFilterResult.emotionalContext.recommendedTone,
            processingTimeMs: emotionalFilterResult.processingTimeMs
          } : undefined
        }
      };

    } catch (error: any) {
      console.error('Error in Subject Chatbot execution:', error);

      // Log error
      await this.logAgentAction(
        'answer_question',
        message.userId,
        context.courseMetadata?.id || null,
        message.sessionId || null,
        { question: message.content, error: error.message },
        null,
        0,
        Date.now() - startTime,
        error.message
      );

      throw error;
    }
  }

  /**
   * Search course materials for relevant content using vector similarity
   * with fallback to direct database lookup when vector search fails
   */
  private async searchCourseMaterials(
    courseId: number,
    query: string,
    limit: number = AGENT_CONFIG.CHATBOT_SEARCH_LIMIT
  ): Promise<CourseMaterial[]> {
    try {
      // Get material stats for logging
      const stats = await getCourseMaterialStats(courseId);

      // Log warning if no materials are available
      if (stats.totalChunks === 0) {
        console.warn(`⚠️ No course materials indexed for course ${courseId}`);
      }

      console.log(
        `Searching ${stats.totalChunks} chunks from ${stats.processedMaterials} materials ` +
        `(${stats.unprocessedMaterials} unprocessed)`
      );

      // Use vector search to find semantically relevant chunks
      let materials: CourseMaterial[] = [];

      if (stats.totalChunks > 0) {
        const searchResults = await vectorSearchCourseMaterials(courseId, query, {
          topK: limit,
          minSimilarity: VECTOR_SEARCH.MIN_SIMILARITY,
          includeMetadata: true
        });

        // Convert search results to CourseMaterial format for backward compatibility
        materials = searchResults.map(result => ({
          id: result.material_id,
          course_id: courseId,
          file_name: result.file_name,
          file_path: result.file_path,
          file_type: result.file_type,
          content_text: result.chunk_text,
          page_number: result.page_number,
          chunk_index: result.chunk_index,
          similarity_score: result.similarity_score,
          uploaded_at: result.uploaded_at
        }));
      }

      console.log(`✓ Found ${materials.length} relevant chunks from vector search (avg similarity: ${
        materials.length > 0
          ? (materials.reduce((sum, m) => sum + (m.similarity_score || 0), 0) / materials.length).toFixed(2)
          : 0
      })`);

      // FALLBACK: If vector search returned insufficient results, try direct content lookup
      if (materials.length < 3) {
        console.log('⚠️ Vector search returned insufficient results, attempting fallback...');
        const fallbackMaterials = await this.fallbackContentLookup(courseId, query, materials);
        if (fallbackMaterials.length > 0) {
          materials = [...materials, ...fallbackMaterials];
          console.log(`✓ Fallback added ${fallbackMaterials.length} materials (total: ${materials.length})`);
        }
      }

      return materials;
    } catch (error) {
      console.error('Error in vector search, attempting fallback:', error);
      // Try fallback even if vector search completely fails
      try {
        return await this.fallbackContentLookup(courseId, query, []);
      } catch (fallbackError) {
        console.error('Fallback also failed:', fallbackError);
        return [];
      }
    }
  }

  /**
   * Fallback: Look up course materials directly from the database
   * when vector search returns no results (e.g., embeddings missing).
   *
   * Strategy:
   * 1. Check if user's query references a specific filename
   * 2. Fetch content directly from course_material_content table
   * 3. If content is empty, try to re-extract from GCS and generate embeddings
   */
  private async fallbackContentLookup(
    courseId: number,
    query: string,
    existingMaterials: CourseMaterial[]
  ): Promise<CourseMaterial[]> {
    const existingMaterialIds = new Set(existingMaterials.map(m => m.id));
    const fallbackMaterials: CourseMaterial[] = [];

    // Step 1: Check if user mentions a specific filename
    const referencedMaterial = await this.findReferencedMaterial(courseId, query);

    if (referencedMaterial && !existingMaterialIds.has(referencedMaterial.id)) {
      console.log(`📎 User referenced file: "${referencedMaterial.file_name}" - fetching content directly`);

      // Fetch content from course_material_content table
      const content = await this.fetchStoredContent(referencedMaterial.id);

      if (content && content.trim().length > 0) {
        // Content exists in DB - split into chunks for the AI
        const contentChunks = this.splitContentForContext(content, referencedMaterial.file_name);
        for (const chunk of contentChunks) {
          fallbackMaterials.push({
            id: referencedMaterial.id,
            course_id: courseId,
            file_name: referencedMaterial.file_name,
            file_path: referencedMaterial.file_path,
            file_type: referencedMaterial.file_type,
            content_text: chunk.text,
            page_number: chunk.page,
            similarity_score: 0.95, // High score since user explicitly referenced this file
            uploaded_at: referencedMaterial.uploaded_at
          });
        }
        console.log(`✓ Fetched ${contentChunks.length} chunks from stored content for "${referencedMaterial.file_name}"`);
      } else {
        // No stored content - try to re-extract from GCS
        console.log(`⚠️ No stored content for "${referencedMaterial.file_name}" - attempting GCS re-extraction`);
        const reExtracted = await this.reExtractFromGCS(referencedMaterial);
        if (reExtracted.length > 0) {
          fallbackMaterials.push(...reExtracted.map(chunk => ({
            ...chunk,
            course_id: courseId
          })));
          console.log(`✓ Re-extracted ${reExtracted.length} chunks from GCS for "${referencedMaterial.file_name}"`);
        }
      }
    }

    // Step 2: If still no results and vector search had 0 results,
    // fetch ALL course materials' content as a last resort
    if (fallbackMaterials.length === 0 && existingMaterials.length === 0) {
      console.log('📚 No specific file referenced - fetching all course material content...');
      const allMaterials = await this.fetchAllCourseContent(courseId);

      for (const mat of allMaterials) {
        if (existingMaterialIds.has(mat.id)) continue;
        fallbackMaterials.push(mat);
      }

      if (fallbackMaterials.length > 0) {
        console.log(`✓ Fetched content from ${fallbackMaterials.length} materials as fallback`);
      }
    }

    return fallbackMaterials;
  }

  /**
   * Find a course material referenced by filename in the user's query
   */
  private async findReferencedMaterial(
    courseId: number,
    query: string
  ): Promise<{ id: number; file_name: string; file_path: string; file_type: string; uploaded_at: Date } | null> {
    try {
      // Get all materials for this course
      const result = await pool.query(
        `SELECT id, file_name, file_path, file_type, uploaded_at
         FROM course_materials
         WHERE course_id = $1
         ORDER BY uploaded_at DESC`,
        [courseId]
      );

      const queryLower = query.toLowerCase();

      // Check if the query mentions any filename (with or without extension)
      for (const row of result.rows) {
        const fileName = row.file_name.toLowerCase();
        const fileNameWithoutExt = fileName.replace(/\.[^/.]+$/, '');

        if (queryLower.includes(fileName) || queryLower.includes(fileNameWithoutExt)) {
          return row;
        }

        // Also check for partial matches (e.g., "anti cyber bullying" matching "AI Powered Anti-Cyber Bullying System.pdf")
        // Normalize both strings for fuzzy matching
        const normalizedFileName = fileNameWithoutExt.replace(/[-_]/g, ' ').replace(/\s+/g, ' ');
        const normalizedQuery = queryLower.replace(/[-_]/g, ' ').replace(/\s+/g, ' ');

        // Check if significant words from the filename appear in the query
        const fileWords = normalizedFileName.split(' ').filter((w: string) => w.length > 2);
        const matchingWords = fileWords.filter((w: string) => normalizedQuery.includes(w));
        const matchRatio = matchingWords.length / fileWords.length;

        if (matchRatio >= 0.5 && fileWords.length >= 2) {
          console.log(`📎 Fuzzy filename match: "${row.file_name}" (${(matchRatio * 100).toFixed(0)}% words matched)`);
          return row;
        }
      }

      return null;
    } catch (error) {
      console.error('Error finding referenced material:', error);
      return null;
    }
  }

  /**
   * Fetch stored content text from course_material_content table
   */
  private async fetchStoredContent(materialId: number): Promise<string | null> {
    try {
      const result = await pool.query(
        `SELECT content_text, content_chunks, metadata
         FROM course_material_content
         WHERE material_id = $1`,
        [materialId]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];

      // Check if extraction had failed
      if (row.metadata?.extraction_method === 'failed') {
        console.warn(`⚠️ Previous text extraction failed for material ${materialId}: ${row.metadata?.error}`);
        return null;
      }

      return row.content_text || null;
    } catch (error) {
      console.error('Error fetching stored content:', error);
      return null;
    }
  }

  /**
   * Split content into manageable chunks for AI context
   */
  private splitContentForContext(
    content: string,
    fileName: string,
    maxChunkSize: number = 2000
  ): Array<{ text: string; page?: number }> {
    const chunks: Array<{ text: string; page?: number }> = [];
    const words = content.split(/\s+/);

    // Split into chunks of ~maxChunkSize characters
    let currentChunk = '';
    let chunkPage = 1;

    for (const word of words) {
      if (currentChunk.length + word.length + 1 > maxChunkSize && currentChunk.length > 0) {
        chunks.push({ text: currentChunk.trim(), page: chunkPage });
        currentChunk = word;
        chunkPage++;
      } else {
        currentChunk += (currentChunk ? ' ' : '') + word;
      }
    }

    if (currentChunk.trim().length > 0) {
      chunks.push({ text: currentChunk.trim(), page: chunkPage });
    }

    // Limit to avoid overwhelming the AI context
    return chunks.slice(0, 15);
  }

  /**
   * Re-extract text from GCS when stored content is missing,
   * and generate embeddings for future queries.
   */
  private async reExtractFromGCS(material: {
    id: number;
    file_name: string;
    file_path: string;
    file_type: string;
    uploaded_at: Date;
  }): Promise<CourseMaterial[]> {
    try {
      // Download file from GCS
      const fileBuffer = await downloadFile(material.file_path);
      console.log(`✓ Downloaded ${material.file_name} from GCS (${fileBuffer.length} bytes)`);

      // Extract text
      const processedDoc = await extractTextFromFile(
        fileBuffer,
        material.file_name,
        material.file_type
      );

      if (!processedDoc.content_text || processedDoc.content_text.trim().length === 0) {
        console.warn(`⚠️ Text extraction returned empty content for ${material.file_name}`);
        return [];
      }

      console.log(`✓ Extracted ${processedDoc.content_chunks.length} chunks from ${material.file_name}`);

      // Store the extracted content in the database for future use
      await pool.query(
        `INSERT INTO course_material_content (material_id, content_text, content_chunks, metadata)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (material_id) DO UPDATE
         SET content_text = EXCLUDED.content_text,
             content_chunks = EXCLUDED.content_chunks,
             metadata = EXCLUDED.metadata,
             last_indexed_at = CURRENT_TIMESTAMP`,
        [
          material.id,
          processedDoc.content_text,
          JSON.stringify(processedDoc.content_chunks),
          JSON.stringify(processedDoc.metadata)
        ]
      );

      // Generate and store embeddings in background (don't block the response)
      this.generateEmbeddingsInBackground(material.id, processedDoc.content_chunks).catch(err => {
        console.error(`Background embedding generation failed for ${material.file_name}:`, err);
      });

      // Return content as CourseMaterial chunks for immediate use
      return processedDoc.content_chunks.slice(0, 15).map(chunk => ({
        id: material.id,
        course_id: 0, // Will be set by caller
        file_name: material.file_name,
        file_path: material.file_path,
        file_type: material.file_type,
        content_text: chunk.text,
        page_number: chunk.metadata.page_number,
        chunk_index: chunk.metadata.chunk_index,
        similarity_score: 0.9, // High score since this is a direct file lookup
        uploaded_at: material.uploaded_at
      }));
    } catch (error) {
      console.error(`Error re-extracting from GCS for ${material.file_name}:`, error);
      return [];
    }
  }

  /**
   * Generate embeddings for chunks in the background so future queries
   * can use vector search instead of the fallback.
   */
  private async generateEmbeddingsInBackground(
    materialId: number,
    chunks: Array<{ chunk_id: string; text: string; metadata: any }>
  ): Promise<void> {
    try {
      console.log(`🔄 Background: Generating embeddings for material ${materialId} (${chunks.length} chunks)...`);

      const chunkTexts = chunks.map(c => c.text);
      const embeddings = await generateEmbeddings(chunkTexts, 5);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i];

        await pool.query(
          `INSERT INTO course_material_embeddings
           (material_id, chunk_id, chunk_text, chunk_metadata, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)
           ON CONFLICT (material_id, chunk_id) DO UPDATE
           SET chunk_text = EXCLUDED.chunk_text,
               chunk_metadata = EXCLUDED.chunk_metadata,
               embedding = EXCLUDED.embedding,
               created_at = CURRENT_TIMESTAMP`,
          [
            materialId,
            chunk.chunk_id,
            chunk.text,
            JSON.stringify(chunk.metadata),
            embeddingToPostgresVector(embedding)
          ]
        );
      }

      console.log(`✅ Background: Generated and stored ${embeddings.length} embeddings for material ${materialId}`);
    } catch (error) {
      console.error(`❌ Background embedding generation failed for material ${materialId}:`, error);
    }
  }

  /**
   * Fetch content from all course materials as a last resort fallback.
   * Used when vector search returns nothing and no specific file is referenced.
   */
  private async fetchAllCourseContent(courseId: number): Promise<CourseMaterial[]> {
    try {
      const result = await pool.query(
        `SELECT cm.id, cm.file_name, cm.file_path, cm.file_type, cm.uploaded_at,
                cmc.content_text
         FROM course_materials cm
         LEFT JOIN course_material_content cmc ON cm.id = cmc.material_id
         WHERE cm.course_id = $1
         ORDER BY cm.uploaded_at DESC
         LIMIT 10`,
        [courseId]
      );

      const materials: CourseMaterial[] = [];

      for (const row of result.rows) {
        if (row.content_text && row.content_text.trim().length > 0) {
          // Truncate content to avoid overwhelming the AI
          const truncatedContent = row.content_text.substring(0, 3000);
          materials.push({
            id: row.id,
            course_id: courseId,
            file_name: row.file_name,
            file_path: row.file_path,
            file_type: row.file_type,
            content_text: truncatedContent,
            similarity_score: 0.7,
            uploaded_at: row.uploaded_at
          });
        } else {
          // Material exists but has no content - try re-extraction
          console.log(`⚠️ Material "${row.file_name}" has no stored content - attempting GCS re-extraction`);
          const reExtracted = await this.reExtractFromGCS(row);
          if (reExtracted.length > 0) {
            materials.push(...reExtracted.map(m => ({ ...m, course_id: courseId })));
          }
        }
      }

      return materials;
    } catch (error) {
      console.error('Error fetching all course content:', error);
      return [];
    }
  }

  /**
   * Extract sources from AI response with proper deduplication
   */
  private extractSources(
    content: string,
    courseMaterials: CourseMaterial[],
    webSearchResults: any[] = []
  ): ResponseSource[] {
    // Use Map for deduplication - key is unique identifier
    const sourcesMap = new Map<string, ResponseSource>();

    // Extract sources from course materials - only if explicitly referenced
    courseMaterials.forEach(material => {
      const isExplicitlyReferenced = content.includes(material.file_name);
      const fileNameWithoutExt = material.file_name.replace(/\.[^/.]+$/, '');
      const isPartiallyReferenced = content.includes(fileNameWithoutExt);

      // FIXED: Only include if explicitly mentioned (removed hasHighSimilarity check)
      if (isExplicitlyReferenced || isPartiallyReferenced) {
        const key = `material_${material.id}`;
        sourcesMap.set(key, {
          source_type: 'course_material',
          source_id: material.id,
          source_name: material.file_name,
          source_url: null,
          source_excerpt: this.extractExcerpt(content, material.file_name),
          page_number: this.extractPageNumber(content, material.file_name),
          relevance_score: material.similarity_score || 0.9
        });
      }
    });

    // Extract internet sources from web search results
    webSearchResults.forEach(result => {
      if (!result.url) return;

      const isReferenced = content.includes(result.title) ||
                          content.includes(result.url) ||
                          content.toLowerCase().includes(result.snippet.toLowerCase().substring(0, 50));

      if (isReferenced) {
        const key = `url_${result.url}`;
        sourcesMap.set(key, {
          source_type: 'internet',
          source_id: null,
          source_name: result.title,
          source_url: result.url,
          source_excerpt: result.snippet,
          page_number: null,
          relevance_score: result.relevanceScore || 0.7
        });
      }
    });

    // Extract URLs from response content
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
    let urlMatch;
    while ((urlMatch = urlPattern.exec(content)) !== null) {
      const url = urlMatch[0];
      const key = `url_${url}`;

      // Only add if not already in map
      if (!sourcesMap.has(key)) {
        // Try to find a source name near the URL
        const contextStart = Math.max(0, urlMatch.index - 100);
        const contextEnd = Math.min(content.length, urlMatch.index + urlMatch[0].length + 100);
        const context = content.substring(contextStart, contextEnd);
        const sourceNameMatch = context.match(/\[Source:\s*([^,\]]+)/i);
        const sourceName = sourceNameMatch ? sourceNameMatch[1].trim() : 'External Source';

        sourcesMap.set(key, {
          source_type: 'internet',
          source_id: null,
          source_name: sourceName,
          source_url: url,
          source_excerpt: null,
          page_number: null,
          relevance_score: 0.7
        });
      }
    }

    return Array.from(sourcesMap.values());
  }

  /**
   * Extract relevant excerpt from content
   */
  private extractExcerpt(content: string, fileName: string): string | null {
    // Find sentences mentioning the file
    const sentences = content.split(/[.!?]+/);
    for (const sentence of sentences) {
      if (sentence.includes(fileName)) {
        return sentence.trim().substring(0, 200);
      }
    }
    return null;
  }

  /**
   * Extract page number from content
   */
  private extractPageNumber(content: string, fileName: string): string | null {
    const pageRegex = new RegExp(`${fileName}.*?(?:Page|p\\.)\\s*(\\d+(?:-\\d+)?)`, 'i');
    const match = content.match(pageRegex);
    return match ? match[1] : null;
  }

  /**
   * Store sources in database with transaction management
   */
  private async storeSources(messageId: number, sources: ResponseSource[]): Promise<void> {
    if (sources.length === 0) {
      return;
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Use batch insert for better performance and atomicity
      const values = sources.map((source, index) => {
        const baseIndex = index * 8;
        return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8})`;
      }).join(', ');

      const params = sources.flatMap(source => [
        messageId,
        source.source_type,
        source.source_id,
        source.source_name,
        source.source_url,
        source.source_excerpt,
        source.page_number,
        source.relevance_score
      ]);

      const query = `
        INSERT INTO response_sources (
          message_id,
          source_type,
          source_id,
          source_name,
          source_url,
          source_excerpt,
          page_number,
          relevance_score
        ) VALUES ${values}
      `;

      await client.query(query, params);
      await client.query('COMMIT');

      console.log(`✓ Stored ${sources.length} sources in transaction`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error storing sources, transaction rolled back:', error);
      throw new Error(`Failed to store sources: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      client.release();
    }
  }

  /**
   * Log agent action to audit log
   */
  private async logAgentAction(
    actionType: string,
    userId: number | null,
    courseId: number | null,
    sessionId: number | null,
    inputData: any,
    outputData: any,
    confidence: number,
    executionTime: number,
    errorMessage?: string
  ): Promise<void> {
    const query = `
      INSERT INTO agent_audit_log (
        agent_type,
        action_type,
        user_id,
        course_id,
        session_id,
        input_data,
        output_data,
        confidence_score,
        execution_time_ms,
        error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;

    await pool.query(query, [
      'subject_chatbot',
      actionType,
      userId,
      courseId,
      sessionId,
      JSON.stringify(inputData),
      JSON.stringify(outputData),
      confidence,
      executionTime,
      errorMessage || null
    ]);
  }

}

// =====================================================
// Type Definitions
// =====================================================

export interface CourseMaterial {
  id: number;
  course_id: number;
  file_name: string;
  file_path: string;
  file_type: string;
  content_text?: string;
  page_number?: number | string;
  chunk_index?: number;
  similarity_score?: number;
  uploaded_at: Date;
}

// ResponseSource type exported from newAgentTypes.ts
