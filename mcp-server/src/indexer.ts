/**
 * Chunk the billing guide by section and search it with BM25 full-text ranking.
 *
 * Indexing happens once, when a BillingIndex is built (at server startup). A search
 * only tokenizes the query and scores the prebuilt postings; it never re-reads or
 * re-indexes the document.
 *
 * Chunking: one chunk per `###` subsection (e.g. 3.2 "Additional internet blocks").
 * A `##` section's own text before its first `###` (or a `##` section with no
 * subsections, like §1 and §9) becomes a chunk under the `##` number. Each chunk
 * keeps its section ID, heading and parent heading so answers can cite "§3.2".
 *
 * Text handling mirrors Python's str/re semantics (whitespace set, Unicode digits,
 * splitlines) so the scores match the original implementation exactly.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_GUIDE = fileURLToPath(new URL("../data/Mobile_Provider_Billing_Guide.md", import.meta.url));

// Python's `\s` / str.isspace() set, which differs slightly from JavaScript's `\s`.
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const HEADING = new RegExp(`^(#{2,3})[${WS}]+(\\p{Nd}+(?:\\.\\p{Nd}+)?)\\.?[${WS}]+(.+?)[${WS}]*$`, "u");
const DOC_ID = new RegExp(`\\*\\*Document ID:\\*\\*[${WS}]*([^${WS}]+)`, "u");
const TOKEN = /[a-z0-9]+/g;
const LEADING_WS = new RegExp(`^[${WS}]+`, "u");
const TRAILING_WS = new RegExp(`[${WS}]+$`, "u");
const LINE_BREAK = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]");

const lstrip = (s: string): string => s.replace(LEADING_WS, "");
const strip = (s: string): string => lstrip(s).replace(TRAILING_WS, "");

/** Python's str.splitlines(): a trailing line break does not add an empty line. */
function splitlines(s: string): string[] {
  const lines = s.split(LINE_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Common words that carry no meaning for retrieval.
export const STOPWORDS: ReadonlySet<string> = new Set(
  `a an and are as at be been but by can do does for from has have how i if in into is it its
  me my of on or our so than that the their them then there these this to was what when where
  which who why will with you your`.split(/\s+/),
);

// Query-side synonyms for billing vocabulary, so "extra data price" finds
// "additional internet blocks ... costs". Expansions score at half weight.
export const SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map([
  ["extra", ["additional"]],
  ["additional", ["extra"]],
  ["data", ["internet"]],
  ["price", ["cost", "charge"]],
  ["cost", ["price", "charge"]],
  ["charge", ["cost", "price", "fee"]],
  ["fee", ["charge"]],
  ["penalty", ["fee", "late"]],
  ["overdue", ["late", "unpaid"]],
  ["late", ["overdue"]],
  ["part", ["partial"]],
  ["partial", ["part"]],
  ["installment", ["partial"]],
  ["pay", ["payment"]],
  ["paid", ["payment"]],
  ["invoice", ["bill"]],
  ["complaint", ["dispute"]],
  ["refund", ["dispute", "adjustment"]],
  ["call", ["phone", "minute"]],
  ["minute", ["phone"]],
  ["allowance", ["included"]],
  ["deadline", ["due"]],
  ["suspend", ["restriction"]],
  ["suspension", ["restriction"]],
  ["cut", ["restriction"]],
]);

export const EXPANSION_WEIGHT = 0.5;
export const HEADING_WEIGHT = 2; // heading tokens count this many times in a chunk

/** Tiny suffix stripper so charge/charges/charged/charging share one form. */
export function stem(token: string): string {
  for (const suffix of ["ing", "ies", "ed", "es", "s"]) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix) && !token.endsWith("ss")) {
      token = token.slice(0, -suffix.length) + (suffix === "ies" ? "y" : "");
      break;
    }
  }
  if (token.length > 3 && token.endsWith("e")) token = token.slice(0, -1);
  return token;
}

function rawTokens(text: string): string[] {
  return text.toLowerCase().match(TOKEN) ?? [];
}

export function tokenize(text: string): string[] {
  return rawTokens(text)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

// Synonyms keyed and valued by stem, so "charges" and "charge" expand the same way.
export const STEM_SYNONYMS: ReadonlyMap<string, readonly string[]> = (() => {
  const merged = new Map<string, string[]>();
  for (const [word, syns] of SYNONYMS) {
    const key = stem(word);
    merged.set(key, [...new Set([...(merged.get(key) ?? []), ...syns.map(stem)])]);
  }
  return merged;
})();

export class Chunk {
  readonly section: string; // "3.2"
  readonly heading: string; // "Additional internet blocks"
  readonly parentHeading: string | null; // "Internet pricing" (null for a top-level section)
  readonly text: string; // body text with markdown emphasis removed

  constructor(section: string, heading: string, parentHeading: string | null, text: string) {
    this.section = section;
    this.heading = heading;
    this.parentHeading = parentHeading;
    this.text = text;
  }

  get reference(): string {
    return `§${this.section} ${this.heading}`;
  }
}

function clean(lines: string[]): string {
  let text = strip(lines.join("\n"));
  text = text.replaceAll("**", "");
  return text.replace(/\n{3,}/g, "\n\n");
}

export function chunkMarkdown(markdown: string): Chunk[] {
  const chunks: Chunk[] = [];
  let top: [number: string, title: string] | null = null; // current ##
  let current: [section: string, heading: string, parent: string | null] | null = null;
  let body: string[] = [];
  let inCode = false;

  const flush = (): void => {
    if (current === null) return;
    const text = clean(body);
    if (text) chunks.push(new Chunk(current[0], current[1], current[2], text));
  };

  for (const line of splitlines(markdown)) {
    if (lstrip(line).startsWith("```")) inCode = !inCode;
    const match = inCode ? null : HEADING.exec(line);
    if (match === null) {
      if (current !== null) body.push(line);
      continue;
    }

    flush();
    body = [];
    const [, level, number, title] = match as unknown as [string, string, string, string];
    if (level === "##") {
      top = [number, title];
      current = [number, title, null];
    } else {
      current = [number, title, top ? top[1] : null];
    }
  }
  flush();
  return chunks;
}

/**
 * Python's round(x, ndigits): round half to even on the exact binary value.
 * `toFixed(100)` gives the exact decimal expansion for any realistic score.
 */
export function pyRound(x: number, ndigits = 3): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const exact = Math.abs(x).toFixed(100);
  const point = exact.indexOf(".");
  const kept = exact.slice(0, point + 1 + ndigits);
  const rest = exact.slice(point + 1 + ndigits);
  let roundUp = rest[0]! > "5" || (rest[0] === "5" && /[1-9]/.test(rest.slice(1)));
  if (rest[0] === "5" && !roundUp) {
    const lastDigit = kept.replace(".", "").at(-1)!;
    roundUp = Number(lastDigit) % 2 === 1; // exact tie: round to even
  }
  let value = Number(kept);
  if (roundUp) value = Number((value + 10 ** -ndigits).toFixed(ndigits));
  return x < 0 ? -value : value;
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
}

/** BM25 (k1=1.5, b=0.75) over section chunks, built once. */
export class BillingIndex {
  readonly document: string;
  readonly documentId: string | null;
  readonly chunks: Chunk[];
  readonly k1 = 1.5;
  readonly b = 0.75;
  buildMs = 0;
  private tf: Map<string, number>[] = [];
  private len: number[] = [];
  private idf = new Map<string, number>();
  private avgLen = 0;

  constructor(document: string, documentId: string | null, chunks: Chunk[]) {
    this.document = document;
    this.documentId = documentId;
    this.chunks = chunks;
  }

  static fromFile(path: string = DEFAULT_GUIDE): BillingIndex {
    const markdown = readFileSync(path, "utf-8");
    return BillingIndex.fromMarkdown(markdown, basename(path));
  }

  static fromMarkdown(markdown: string, document: string): BillingIndex {
    const started = performance.now();
    const docId = DOC_ID.exec(markdown);
    const index = new BillingIndex(document, docId ? docId[1]! : null, chunkMarkdown(markdown));
    index._build();
    index.buildMs = performance.now() - started;
    return index;
  }

  /** The one indexing pass: term frequencies, chunk lengths and IDF. */
  _build(): void {
    const df = new Map<string, number>();
    for (const chunk of this.chunks) {
      const heading = tokenize(chunk.heading);
      const tokens = [
        ...Array.from({ length: HEADING_WEIGHT }, () => heading).flat(),
        ...tokenize(chunk.parentHeading ?? ""),
        ...tokenize(chunk.text),
      ];
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.tf.push(tf);
      this.len.push(tokens.length);
      for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const n = this.chunks.length;
    this.avgLen = n ? this.len.reduce((a, b) => a + b, 0) / n : 0;
    this.idf = new Map([...df].map(([term, d]) => [term, Math.log(1 + (n - d + 0.5) / (d + 0.5))]));
  }

  /** Query term -> weight, in first-seen order (the order scores are summed in). */
  queryWeights(query: string): Map<string, number> {
    const weights = new Map<string, number>();
    for (const raw of rawTokens(query)) {
      if (STOPWORDS.has(raw)) continue;
      const s = stem(raw);
      weights.set(s, 1.0);
      for (const syn of STEM_SYNONYMS.get(s) ?? []) {
        weights.set(syn, Math.max(weights.get(syn) ?? 0, EXPANSION_WEIGHT));
      }
    }
    return weights;
  }

  search(query: string, maxResults = 3): SearchHit[] {
    const weights = this.queryWeights(query);
    const hits: SearchHit[] = [];
    this.chunks.forEach((chunk, i) => {
      const tf = this.tf[i]!;
      const length = this.len[i]!;
      let score = 0;
      for (const [term, weight] of weights) {
        const f = tf.get(term);
        if (!f) continue;
        const norm = (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * length) / this.avgLen));
        score += weight * this.idf.get(term)! * norm;
      }
      if (score > 0) hits.push({ chunk, score });
    });
    hits.sort((x, y) => y.score - x.score || (x.chunk.section < y.chunk.section ? -1 : x.chunk.section > y.chunk.section ? 1 : 0));
    return hits.slice(0, maxResults);
  }
}
