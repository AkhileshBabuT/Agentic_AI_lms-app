import { AutoTokenizer, AutoModelForSequenceClassification } from '@xenova/transformers';
import { RERANKER_CONFIG } from '../config/constants';

let loaded: Promise<{ tokenizer: any; model: any }> | null = null;

function load() {
  if (!loaded) {
    loaded = (async () => {
      const tokenizer = await AutoTokenizer.from_pretrained(RERANKER_CONFIG.MODEL_ID);
      const model = await AutoModelForSequenceClassification.from_pretrained(RERANKER_CONFIG.MODEL_ID, {
        quantized: true,
      });
      return { tokenizer, model };
    })();
    // A failed load must not poison every later call into the fallback forever.
    loaded.catch(() => { loaded = null; });
  }
  return loaded;
}

/**
 * Stage-2 precision: cross-encoder re-scores stage-1 vector hits.
 * Never throws — any failure degrades to the stage-1 (vector similarity) order.
 */
export async function rerank<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  topN: number
): Promise<T[]> {
  if (items.length <= topN) return items;
  try {
    const { tokenizer, model } = await load();
    const scored: Array<{ item: T; score: number }> = [];
    for (const item of items) {
      const inputs = tokenizer(query, {
        text_pair: getText(item).slice(0, RERANKER_CONFIG.MAX_DOC_CHARS),
        truncation: true,
      });
      const { logits } = await model(inputs);
      scored.push({ item, score: logits.data[0] as number });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topN).map(s => s.item);
  } catch (error) {
    console.error('Reranker failed, using vector order:', error);
    return items.slice(0, topN);
  }
}
