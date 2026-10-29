import { writeFileSync } from 'node:fs';
export default function (pi) {
  pi.registerProvider('free-test-bootstrap', {
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'test',
    api: 'openai-completions',
    models: [
      {
        id: 'bootstrap',
        name: 'No-inference bootstrap',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 256,
      },
    ],
  });
  pi.on('session_start', async (_event, ctx) => {
    const models = ctx.modelRegistry
      .getAll()
      .filter((m) => ['free-kilo', 'free-ovh'].includes(m.provider));
    const data = {
      at: new Date().toISOString(),
      models,
      available: ctx.modelRegistry
        .getAvailable()
        .filter((m) => ['free-kilo', 'free-ovh'].includes(m.provider))
        .map((m) => ({ id: m.id, provider: m.provider })),
      tools: pi.getActiveTools(),
    };
    writeFileSync(process.env.FREE_TEST_OUTPUT, JSON.stringify(data, null, 2));
    process.exit(0);
  });
}
