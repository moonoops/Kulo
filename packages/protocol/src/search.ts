export type SearchAdapterId = "exa" | "tavily" | "brave" | "duckduckgo";
export type SearchPlanStatus = "unverified" | "ready" | "needs_auth" | "error" | "disabled";

export interface SearchFailure {
  kind: "auth" | "quota" | "rate_limit" | "unsupported_tool" | "invalid_request" | "network" | "timeout" | "no_results" | "ungrounded" | "upstream" | "unknown";
  message: string;
  upstreamStatus?: number;
  upstreamCode?: string;
  parameter?: string;
  requestId?: string;
  retryable: boolean;
}

export interface SearchPlanView {
  id: string;
  name: string;
  adapter: SearchAdapterId;
  enabled: boolean;
  baseUrl?: string;
  hasCredential: boolean;
  revision: number;
  status: SearchPlanStatus;
  lastCheckedAt?: number;
  error?: string;
  failure?: SearchFailure;
  healthRevision?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SearchSnapshot { revision: number; healthRevision?: number; plans: SearchPlanView[] }

export interface SearchPlanInput {
  id?: string;
  expectedRevision?: number;
  name: string;
  adapter: SearchAdapterId;
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
}

export type WebSource = {
  id: string;
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  publishedAt?: string;
  fetchedAt?: number;
};

export interface WebSearchInput {
  query: string;
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  timeRange?: "day" | "week" | "month" | "year";
}

export interface SearchAttempt { planId: string; name: string; error?: string; failure?: SearchFailure }
export interface WebSearchResult {
  query: string;
  planId: string;
  planName: string;
  answer?: string;
  searchSuggestions?: string;
  sources: WebSource[];
  attempts: SearchAttempt[];
}

export interface WebPageResult {
  url: string;
  title: string;
  content: string;
  truncated: boolean;
  sources: WebSource[];
}
