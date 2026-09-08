const $ = (sel) => document.querySelector(sel);

const EXAMPLES = [
	"what pagination approach should I use?",
	"How do Cloudflare components fit together to build a RAG system?",
	"What remains unanswered about this knowledge base?",
];

const KINDS = ["raw", "reflection", "summary"];

/** Fetch JSON, surfacing API errors as thrown Errors. */
async function api(path, options) {
	const res = await fetch(path, options);
	let body;
	try {
		body = await res.json();
	} catch {
		throw new Error(`${res.status} ${res.statusText}`);
	}
	if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
	return body;
}

function setStatus(el, message, kind) {
	if (!message) {
		el.hidden = true;
		return;
	}
	el.hidden = false;
	el.textContent = message;
	el.className = `status${kind ? ` ${kind}` : ""}`;
}

/** Escape untrusted text before inserting it as HTML. */
function esc(text) {
	return String(text ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

/**
 * The model answers in light markdown. Escape first, then apply formatting to
 * the escaped string, so model output can never inject markup.
 */
function formatAnswer(text) {
	return esc(text)
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/^\s*[*-]\s+/gm, "• ");
}

// ---------- tabs ----------

document.querySelectorAll(".tab").forEach((tab) => {
	tab.addEventListener("click", () => {
		document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
		document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("is-active", p.id === `panel-${tab.dataset.panel}`));
		if (tab.dataset.panel === "browse") loadDocuments();
	});
});

// ---------- search ----------

const examplesEl = $("#examples");
EXAMPLES.forEach((text) => {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "example";
	button.textContent = text;
	button.addEventListener("click", () => {
		$("#query").value = text;
		$("#search-form").requestSubmit();
	});
	examplesEl.append(button);
});

$("#search-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const query = $("#query").value.trim();
	if (!query) return;

	const button = event.target.querySelector("button");
	button.disabled = true;
	$("#answer-card").hidden = true;
	$("#sources").hidden = true;
	setStatus($("#search-status"), "Embedding query, searching, and generating an answer…", "busy");

	try {
		const data = await api("/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query }),
		});

		setStatus($("#search-status"), null);
		$("#answer-text").innerHTML = formatAnswer(data.answer ?? "(no answer returned)");
		$("#answer-card").hidden = false;
		renderSources(data.sources ?? []);
	} catch (err) {
		setStatus($("#search-status"), err.message, "error");
	} finally {
		button.disabled = false;
	}
});

function renderSources(sources) {
	const list = $("#source-list");
	list.replaceChildren();

	for (const s of sources) {
		const kind = KINDS.includes(s.doc_type) ? s.doc_type : "raw";
		const boosted = (s.boost ?? 1) > 1;

		const li = document.createElement("li");
		li.className = "card";
		li.dataset.kind = kind;
		li.innerHTML = `
			<div class="card-head">
				<span class="badge">${esc(kind)}</span>
				<span class="doc-id">${esc(s.id)}</span>
				<span class="score">
					${boosted ? `${(s.rawScore ?? 0).toFixed(3)} × <span class="boosted">${(+s.boost).toFixed(1)}</span> = ` : ""}
					<b>${(s.score ?? 0).toFixed(3)}</b>
				</span>
			</div>
			<p>${esc(s.content)}</p>`;
		list.append(li);
	}

	$("#sources").hidden = sources.length === 0;
}

// ---------- ingest ----------

$("#ingest-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const content = $("#content").value.trim();
	if (!content) return;

	const button = event.target.querySelector("button[type=submit]");
	button.disabled = true;
	setStatus($("#ingest-status"), "Embedding and storing document…", "busy");

	try {
		const payload = { content };
		const id = $("#doc-id").value.trim();
		const source = $("#source").value.trim();
		if (id) payload.id = id;
		if (source) payload.source = source;

		const result = await api("/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		if ($("#run-reflection").checked) {
			setStatus($("#ingest-status"), `Stored ${result.documentId}. Synthesising against related documents…`, "busy");
			await api("/reflect", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: result.documentId }),
			});
			setStatus($("#ingest-status"), `Stored ${result.documentId} and ran reflection. Check the knowledge base tab.`);
		} else {
			setStatus($("#ingest-status"), `Stored ${result.documentId}.`);
		}

		$("#content").value = "";
		$("#doc-id").value = "";
	} catch (err) {
		setStatus($("#ingest-status"), err.message, "error");
	} finally {
		button.disabled = false;
	}
});

// ---------- browse ----------

async function loadDocuments() {
	setStatus($("#browse-status"), "Loading…", "busy");
	$("#counts").hidden = true;

	try {
		const { documents = [] } = await api("/documents");
		setStatus($("#browse-status"), null);

		const counts = { raw: 0, reflection: 0, summary: 0 };
		for (const d of documents) {
			const kind = KINDS.includes(d.doc_type) ? d.doc_type : "raw";
			counts[kind]++;
		}

		const countsEl = $("#counts");
		countsEl.replaceChildren();
		for (const kind of KINDS) {
			const div = document.createElement("div");
			div.className = "count";
			div.dataset.kind = kind;
			const plural = { raw: "raw documents", reflection: "reflections", summary: "summaries" };
			div.innerHTML = `<b>${counts[kind]}</b><span>${counts[kind] === 1 ? kind : plural[kind]}</span>`;
			countsEl.append(div);
		}
		countsEl.hidden = false;

		const list = $("#doc-list");
		list.replaceChildren();

		if (documents.length === 0) {
			const p = document.createElement("p");
			p.className = "empty";
			p.textContent = "Nothing stored yet. Add a document to get started.";
			list.append(p);
			return;
		}

		for (const d of documents) {
			const kind = KINDS.includes(d.doc_type) ? d.doc_type : "raw";
			const li = document.createElement("li");
			li.className = "card";
			li.dataset.kind = kind;
			li.innerHTML = `
				<div class="card-head">
					<span class="badge">${esc(kind)}</span>
					<span class="doc-id">${esc(d.id)}</span>
					${d.reflection_score > 0 ? `<span class="score">boost <b>${(+d.reflection_score).toFixed(1)}×</b></span>` : ""}
				</div>
				<p>${esc(d.preview)}${(d.preview ?? "").length >= 200 ? "…" : ""}</p>`;
			list.append(li);
		}
	} catch (err) {
		setStatus($("#browse-status"), err.message, "error");
	}
}

$("#refresh").addEventListener("click", loadDocuments);

$("#consolidate").addEventListener("click", async (event) => {
	event.target.disabled = true;
	setStatus($("#browse-status"), "Consolidating recent reflections…", "busy");
	try {
		await api("/consolidate", { method: "POST" });
		await loadDocuments();
	} catch (err) {
		setStatus($("#browse-status"), err.message, "error");
	} finally {
		event.target.disabled = false;
	}
});
