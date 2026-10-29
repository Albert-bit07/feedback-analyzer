// Test-only entrypoint: the production configuration never imports this module.
import worker, { type Env } from '../../src/index';
import { authorize } from '../../src/access';
import { processPending } from '../../src/processing';

export default {
  async fetch(request: Request, bindings: Omit<Env, 'AI'>): Promise<Response> {
    const env = {
      ...bindings,
      AI: {
        async run(_model: string, input: { messages: { content: string }[] }) {
          const duplicates = input.messages[0].content.includes('duplicate_ids');
          return { response: JSON.stringify(duplicates ? { duplicate_ids: [] } : {
            sentiment: 'negative', category: 'browser-fixture', summary: 'Controlled analysis for browser integration.',
          }) };
        },
      } as unknown as Ai,
    };
    if (new URL(request.url).pathname === '/__test/process' && request.method === 'POST') {
      const denied = await authorize(request, env.DASHBOARD_PASSWORD);
      if (denied) return denied;
      await processPending(env);
      return Response.json({ processed: true });
    }
    return worker.fetch(request, env);
  },
};
