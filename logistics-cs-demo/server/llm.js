// ============ LLM 接入：DeepSeek（LangChain ChatDeepSeek） ============
import 'dotenv/config';
import { ChatDeepSeek } from '@langchain/deepseek';

export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

export function createLlm() {
  return new ChatDeepSeek({
    model: DEEPSEEK_MODEL,
    temperature: 0.3,
    apiKey: DEEPSEEK_API_KEY,
    maxRetries: 2
  });
}
