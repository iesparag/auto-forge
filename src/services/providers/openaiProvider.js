import OpenAI from 'openai';

function client(apiKey) {
  if (!apiKey) throw new Error('OpenAI API key is not configured.');
  return new OpenAI({ apiKey });
}

// Chat completion → text. `effort` is ignored (Anthropic-only concept).
// `images` (optional) = [{ media_type, data(base64) }] → sent as vision input.
// When `json` is set, forces guaranteed-valid JSON output (json_object mode).
export async function complete({ apiKey, model, system, user, maxTokens = 16000, json = false, images = [] }) {
  const userContent = images.length
    ? [
        { type: 'text', text: user },
        ...images.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:${img.media_type};base64,${img.data}` },
        })),
      ]
    : user;
  const params = {
    model,
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
  };
  if (json) params.response_format = { type: 'json_object' };
  const res = await client(apiKey).chat.completions.create(params);
  return res.choices?.[0]?.message?.content || '';
}

export async function test(apiKey, model) {
  const res = await client(apiKey).chat.completions.create({
    model,
    max_completion_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  });
  return { reply: (res.choices?.[0]?.message?.content || '').trim() };
}
