import 'dotenv/config';
import OpenAI from 'openai';

const {
  OPENAI_API_KEY,
  AI_MODEL = 'gpt-5-mini',
} = process.env;
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

export const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
export const model = AI_MODEL;

export async function chat(messages, extra = {}) {
  const res = await openai.chat.completions.create({ model, messages, ...extra });
  return (res.choices?.[0]?.message?.content || '').trim();
}
