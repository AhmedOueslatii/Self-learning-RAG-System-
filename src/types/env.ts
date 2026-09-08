export interface Env {
	VECTORIZE: VectorizeIndex;
	DB: D1Database;
	AI: Ai;
	/** Static assets for the web UI; absent if no assets binding is configured. */
	ASSETS?: Fetcher;
}
