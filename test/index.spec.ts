import { env, createExecutionContext, waitOnExecutionContext, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("RAG worker routing", () => {
	it("responds on the root route (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toMatchInlineSnapshot(`"RAG system running"`);
	});

	it("responds on the root route (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(response.status).toBe(200);
		expect(await response.text()).toMatchInlineSnapshot(`"RAG system running"`);
	});

	it("rejects /ingest without content", async () => {
		const response = await SELF.fetch("https://example.com/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "doc-1" }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "content is required" });
	});

	it("rejects /search without a query", async () => {
		const response = await SELF.fetch("https://example.com/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "query is required" });
	});

	it("rejects /reflect without an id", async () => {
		const response = await SELF.fetch("https://example.com/reflect", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "id is required" });
	});
});
