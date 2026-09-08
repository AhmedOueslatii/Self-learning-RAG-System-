import { Env } from '../types/env';

const REFLECTION_BOOST = 1.5;
const CONSOLIDATION_THRESHOLD = 3;

export async function reflect(newDocId: string, newDocContent: string, env: Env): Promise<void> {
	// 1. Find semantically related documents
	const embResult = await env.AI.run('@cf/baai/bge-small-en-v1.5', {
		text: [newDocContent.slice(0, 512)],
	});
	const queryVector = (embResult as any).data?.[0];
	if (!queryVector) return;

	const related = await env.VECTORIZE.query(queryVector, {
		topK: 5,
		filter: { doc_type: { $eq: 'raw' } },
		returnMetadata: 'all',
	});

	const relatedDocs = (related.matches ?? []).filter((m) => m.id !== newDocId && (m.score ?? 0) > 0.65);

	if (relatedDocs.length === 0) return;

	// 2. Build synthesis prompt
	const relatedSummaries = relatedDocs
		.slice(0, 3)
		.map((m, i) => `Document ${i + 1}: ${String(m.metadata?.content ?? '').slice(0, 300)}`)
		.join('\n\n');

	const prompt = `You are synthesising knowledge across documents in a knowledge base.

New document:
${newDocContent.slice(0, 600)}

Related existing documents:
${relatedSummaries}

Write exactly three sentences:
1. What the new document adds that the existing documents don't already cover
2. How the new document connects to or extends the existing documents
3. What gap or question remains unanswered across all these documents

Be specific. Reference actual content. Do not summarise — synthesise.`;

	// 3. Call reflection model
	const llmResp = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
		messages: [{ role: 'user', content: prompt }],
		max_tokens: 180,
	});

	const reflectionText = (llmResp as any)?.response?.trim();
	if (!reflectionText || reflectionText.length < 40) return;

	// 4. Embed and store reflection
	const reflEmbResult = await env.AI.run('@cf/baai/bge-small-en-v1.5', {
		text: [reflectionText],
	});
	const reflVector = (reflEmbResult as any).data?.[0];
	if (!reflVector) return;

	const reflectionId = `refl_${newDocId}_${Date.now()}`;

	await env.VECTORIZE.upsert([
		{
			id: reflectionId,
			values: reflVector,
			metadata: {
				content: reflectionText,
				doc_type: 'reflection',
				parent_id: newDocId,
				reflection_score: REFLECTION_BOOST,
				source_doc_ids: relatedDocs.map((m) => m.id).join(','),
				date_created: new Date().toISOString(),
			},
		},
	]);

	await env.DB.prepare(
		`INSERT INTO documents
     (id, content, doc_type, reflection_score, parent_id, date_created)
     VALUES (?, ?, 'reflection', ?, ?, ?)`
	)
		.bind(reflectionId, reflectionText, REFLECTION_BOOST, newDocId, new Date().toISOString())
		.run();

	// 5. Check if consolidation needed
	const recentCount = await env.DB.prepare(
		`SELECT COUNT(*) as cnt FROM documents WHERE doc_type = 'reflection' AND date_created > datetime('now', '-1 hour')`
	).first<{ cnt: number }>();

	if ((recentCount?.cnt ?? 0) >= CONSOLIDATION_THRESHOLD) {
		await consolidate(env);
	}
}

export async function consolidate(env: Env): Promise<void> {
	const recent = await env.DB.prepare(
		`SELECT id, content FROM documents
       WHERE doc_type = 'reflection'
       AND id NOT IN (
         SELECT DISTINCT parent_id FROM documents
         WHERE doc_type = 'summary' AND parent_id IS NOT NULL
       )
       ORDER BY date_created DESC
       LIMIT 6`
	).all<{ id: string; content: string }>();

	if (!recent.results || recent.results.length < CONSOLIDATION_THRESHOLD) return;

	const reflectionTexts = recent.results.map((r, i) => `Reflection ${i + 1}: ${r.content}`).join('\n\n');

	const prompt = `You are consolidating multiple knowledge reflections into a single compressed insight.

${reflectionTexts}

Write two to three sentences capturing cross-cutting patterns. What does the knowledge base understand now that it didn't before? What's the most important open question?

Be precise. No preamble.`;

	const llmResp = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
		messages: [{ role: 'user', content: prompt }],
		max_tokens: 320,
	});

	const summaryText = (llmResp as any)?.response?.trim();
	if (!summaryText || summaryText.length < 40) return;

	const embResult = await env.AI.run('@cf/baai/bge-small-en-v1.5', {
		text: [summaryText],
	});
	const summaryVector = (embResult as any).data?.[0];
	if (!summaryVector) return;

	const summaryId = `summary_${Date.now()}`;

	await env.VECTORIZE.upsert([
		{
			id: summaryId,
			values: summaryVector,
			metadata: {
				content: summaryText,
				doc_type: 'summary',
				reflection_score: REFLECTION_BOOST * 1.2,
				source_reflection_ids: recent.results.map((r) => r.id).join(','),
				date_created: new Date().toISOString(),
			},
		},
	]);

	await env.DB.prepare(
		`INSERT INTO documents (id, content, doc_type, reflection_score, date_created)
     VALUES (?, ?, 'summary', ?, ?)`
	)
		.bind(summaryId, summaryText, REFLECTION_BOOST * 1.2, new Date().toISOString())
		.run();
}
