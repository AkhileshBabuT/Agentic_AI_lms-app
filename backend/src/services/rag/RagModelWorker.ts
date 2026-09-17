import { parentPort } from 'worker_threads';
import { embedQuery } from '../embeddingService';
import { AutoTokenizer, AutoModelForSequenceClassification } from '@xenova/transformers';
import { RERANKER_CONFIG } from '../../config/constants';

let loaded: Promise<{ tokenizer: any; model: any }> | undefined;
parentPort?.on('message', async ({ id, operation, question, texts }) => {
  try {
    let value: number[];
    if (operation === 'embed') value = await embedQuery(question);
    else {
      if (!/^[a-f0-9]{40}$/i.test(RERANKER_CONFIG.MODEL_REVISION)) throw new Error('An immutable reranker revision is required');
      if (!loaded) {
        loaded = (async () => ({
        tokenizer: await AutoTokenizer.from_pretrained(RERANKER_CONFIG.MODEL_ID, { revision: RERANKER_CONFIG.MODEL_REVISION }),
        model: await AutoModelForSequenceClassification.from_pretrained(RERANKER_CONFIG.MODEL_ID, { quantized: true, revision: RERANKER_CONFIG.MODEL_REVISION })
        }))();
        loaded.catch(() => { loaded = undefined; });
      }
      const { tokenizer, model } = await loaded;
      value = [];
      for (const text of texts) {
        const output = await model(tokenizer(question, { text_pair: text.slice(0, RERANKER_CONFIG.MAX_DOC_CHARS), truncation: true }));
        value.push(Number(output.logits.data[0]));
      }
    }
    parentPort!.postMessage({ id, value });
  } catch { parentPort!.postMessage({ id, error: 'Local model inference failed' }); }
});
