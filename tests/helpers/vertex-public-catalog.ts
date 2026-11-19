export interface VertexLifecycleRow {
  id: string;
  released?: string;
  retired?: string;
  replacement?: string;
}

export function vertexLifecycleHtml(rows: VertexLifecycleRow[], retired: VertexLifecycleRow[] = []): string {
  const table = (records: VertexLifecycleRow[]) => `<table><tr><th>Model ID</th><th>Release date</th><th>Retirement date</th><th>Replacement model ID</th></tr>${records.map((row) => `<tr><td><code>${row.id}</code></td><td>${row.released ?? "January 1, 2026"}</td><td>${row.retired ?? "No retirement date announced"}</td><td><code>${row.replacement ?? ""}</code></td></tr>`).join("")}</table>`;
  return `<html><body><nav><code>gemini-nav-should-not-appear</code></nav><div class="devsite-article-body"><h2>Latest available models</h2>${table(rows)}<h3 id="retired-models">Retired models</h3>${table(retired)}</div></body></html>`;
}

export function vertexPreviewOverviewHtml(paths = ["fixture-preview"]): string {
  return `<html><body><div class="devsite-article-body"><h2>Generally available models</h2><a href="/gemini-enterprise-agent-platform/models/gemini/wrong-section">Ignore</a><h2 id="preview-gemini-models">Preview Gemini models</h2><div>${paths.map((page) => `<a href="/gemini-enterprise-agent-platform/models/gemini/${page}">${page}</a>`).join("")}</div><h2>Gemma</h2><a href="/gemini-enterprise-agent-platform/models/gemini/after-section">Ignore</a></div></body></html>`;
}

export function vertexPreviewDetailHtml(ids = ["gemini-fixture-preview"], options: { released?: string; contextWindow?: number; maxTokens?: number } = {}): string {
  return `<html><body><code>gemini-nav-should-not-appear</code><div class="devsite-article-body"><table class="geap-model-table"><tr><th>Model ID</th><td><code>${ids[0]}</code></td></tr><tr><th>Token limits</th><th>Context window</th><td>${options.contextWindow ?? 1_048_576}</td></tr><tr><th>Maximum output tokens</th><td>${options.maxTokens ?? 65_536}</td></tr><tr><th>Versions</th><td><ul>${ids.map((id) => `<li><code>${id}</code></li><ul><li>Launch stage: Public preview</li><li>Release date: ${options.released ?? "January 1, 2026"}</li></ul>`).join("")}</ul></td></tr></table><pre><code>gemini-example-should-not-appear</code></pre></div></body></html>`;
}

export function vertexPublicCatalogDocuments(ids = ["gemini-catalog-latest"], previewIds = ["gemini-fixture-preview"]): Map<string, string> {
  return new Map([
    ["/gemini-enterprise-agent-platform/models/model-versions", vertexLifecycleHtml(ids.map((id) => ({ id })))],
    ["/gemini-enterprise-agent-platform/models/google-models", vertexPreviewOverviewHtml()],
    ["/gemini-enterprise-agent-platform/models/gemini/fixture-preview", vertexPreviewDetailHtml(previewIds)],
  ]);
}
