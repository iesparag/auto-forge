import Anthropic from '@anthropic-ai/sdk';

function client(apiKey) {
  if (!apiKey) throw new Error('Anthropic API key is not configured.');
  return new Anthropic({ apiKey });
}

// Streamed completion → concatenated text. Uses adaptive thinking + effort.
// `images` (optional) = [{ media_type, data(base64) }] → sent as vision input.
// `json` is accepted for API parity (the loose parser + retry handles JSON here).
export async function complete({ apiKey, model, effort, system, user, maxTokens = 64000, json = false, images = [] }) {
  const userContent = images.length
    ? [
        { type: 'text', text: user },
        ...images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.media_type, data: img.data },
        })),
      ]
    : user;
  const stream = client(apiKey).messages.stream({
    model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: effort || 'high' },
    system,
    messages: [{ role: 'user', content: userContent }],
  });
  const message = await stream.finalMessage();
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export async function test(apiKey, model) {
  const res = await client(apiKey).messages.create({
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  });
  const reply = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return { reply };
}
