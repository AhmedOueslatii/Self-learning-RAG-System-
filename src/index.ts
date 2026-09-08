import { Env } from './types/env';
import { reflect, consolidate } from './engines/reflection';

const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
// The tutorial uses @cf/moonshotai/kimi-k2.5, which no longer exists and whose
// successors are paid-plan only. Llama 3.3 70B is the strongest free-plan model.
const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

async function embed(env: Env, text: string): Promise<number[]> {
	const result = await env.AI.run(EMBEDDING_MODEL, { text: [text.slice(0, 512)] });
	return (result as any).data[0];
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/ingest' && request.method === 'POST') {
			const { id, content, source } = (await request.json()) as {
				id?: string;
				content?: string;
				source?: string;
			};

			if (!content) {
				return Response.json({ error: 'content is required' }, { status: 400 });
			}

			const documentId = id ?? `doc_${Date.now()}`;
			const vector = await embed(env, content);

			await env.VECTORIZE.upsert([
				{
					id: documentId,
					values: vector,
					metadata: {
						content: content.slice(0, 1000),
						source: source ?? '',
						doc_type: 'raw',
					},
				},
			]);

			await env.DB.prepare('INSERT OR REPLACE INTO documents (id, content, source, doc_type) VALUES (?, ?, ?, ?)')
				.bind(documentId, content, source ?? '', 'raw')
				.run();

			// Reflection runs after the response is sent, so ingest stays fast.
			ctx.waitUntil(
				reflect(documentId, content, env).catch((err) => {
					console.warn('[reflection] failed for', documentId, err.message);
				})
			);

			return Response.json({ success: true, documentId });
		}

		if (url.pathname === '/search' && request.method === 'POST') {
			const { query } = (await request.json()) as { query?: string };

			if (!query) {
				return Response.json({ error: 'query is required' }, { status: 400 });
			}

			const vector = await embed(env, query);

			const results = await env.VECTORIZE.query(vector, {
				topK: 5,
				returnMetadata: 'all',
			});

			// Reflections and summaries outrank raw chunks on conceptual queries.
			// rawScore and boost are kept so clients can show why a result ranked.
			const boosted = (results.matches ?? [])
				.map((m) => {
					const docType = m.metadata?.doc_type as string | undefined;
					const boost = docType === 'reflection' || docType === 'summary' ? Number(m.metadata?.reflection_score ?? 1.5) : 1;
					const rawScore = m.score ?? 0;
					return { ...m, rawScore, boost, score: rawScore * boost };
				})
				.sort((a, b) => b.score - a.score);

			const context = boosted
				.map((m) => m.metadata?.content as string)
				.filter(Boolean)
				.join('\n\n');

			const answer = await env.AI.run(LLM_MODEL, {
				messages: [
					{ role: 'system', content: 'Answer using only the context provided.' },
					{ role: 'user', content: `Context:\n${context}\n\nQuestion: ${query}` },
				],
				max_tokens: 256,
			});

			return Response.json({
				answer: (answer as any).response,
				sources: boosted.map((m) => ({
					id: m.id,
					score: m.score,
					rawScore: m.rawScore,
					boost: m.boost,
					doc_type: m.metadata?.doc_type ?? 'raw',
					content: (m.metadata?.content as string) ?? '',
					source: (m.metadata?.source as string) ?? '',
				})),
			});
		}

		// Runs reflection synchronously so failures surface in the response.
		if (url.pathname === '/reflect' && request.method === 'POST') {
			const { id } = (await request.json()) as { id?: string };
			if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

			const row = await env.DB.prepare('SELECT content FROM documents WHERE id = ?').bind(id).first<{ content: string }>();
			if (!row) return Response.json({ error: `no document ${id}` }, { status: 404 });

			try {
				await reflect(id, row.content, env);
				return Response.json({ success: true, id });
			} catch (err: any) {
				return Response.json({ success: false, error: String(err?.message ?? err) }, { status: 500 });
			}
		}

		if (url.pathname === '/consolidate' && request.method === 'POST') {
			await consolidate(env);
			return Response.json({ success: true });
		}

		if (url.pathname === '/documents' && request.method === 'GET') {
			const rows = await env.DB.prepare(
				'SELECT id, doc_type, reflection_score, date_created, substr(content, 1, 200) AS preview FROM documents ORDER BY date_created DESC LIMIT 50'
			).all();
			return Response.json({ documents: rows.results });
		}

		if (url.pathname === '/health') {
			return Response.json({ status: 'ok' });
		}

		// Anything else is a static asset (the web UI). Falls back to a plain
		// response when no assets binding is configured.
		if (env.ASSETS) {
			return env.ASSETS.fetch(request);
		}

		return new Response('RAG system running', { status: 200 });
	},
};
