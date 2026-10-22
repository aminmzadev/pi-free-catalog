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
      .filter((m) => ['free-kilo', 'free-zen'].includes(m.provider));
    const classifiers = ctx.modelRegistry
      .getModelsOfType('classifier')
      .filter((m) => m.provider === 'free-zen');
    let result;
    if (process.env.FREE_TEST_CLASSIFIER === '1') {
      const model = classifiers.find((m) => m.id === 'jev-1.13-free');
      const context = {
        state: { text: 'The user asks what 17 multiplied by 19 equals.' },
        questions: {
          topic: {
            type: 'choice',
            instructions: 'Choose the topic.',
            criteria: {
              math: 'An arithmetic or mathematics question.',
              other: 'Any other topic.',
            },
          },
        },
      };
      try {
        result = await ctx.modelRegistry.classify(model, context, {
          signal: AbortSignal.timeout(30000),
        });
      } catch (e) {
        result = { error: String(e) };
      }
    }
    const data = {
      at: new Date().toISOString(),
      models,
      classifiers,
      available: ctx.modelRegistry
        .getAvailable()
        .filter((m) => ['free-kilo', 'free-zen'].includes(m.provider))
        .map((m) => ({ id: m.id, provider: m.provider })),
      tools: pi.getActiveTools(),
      classifierResult: result,
    };
    writeFileSync(process.env.FREE_TEST_OUTPUT, JSON.stringify(data, null, 2));
    process.exit(0);
  });
}
