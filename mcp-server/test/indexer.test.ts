import { describe, expect, it } from "vitest";

import { BillingIndex, Chunk, chunkMarkdown, stem, tokenize } from "../src/indexer.ts";

const index = BillingIndex.fromFile();

describe("indexer", () => {
  it("chunks the guide by subsection", () => {
    const sections = index.chunks.map((c) => c.section);
    expect(sections.slice(0, 4)).toEqual(["1", "2.1", "2.2", "2.3"]);
    expect(sections).toContain("3.2");
    expect(sections).toContain("9");
    expect(sections).toHaveLength(25);
    expect(new Set(sections).size).toBe(25);
  });

  it("keeps heading, parent and reference on each chunk", () => {
    const chunk = index.chunks.find((c) => c.section === "3.2")!;
    expect(chunk.heading).toBe("Additional internet blocks");
    expect(chunk.parentHeading).toBe("Internet pricing");
    expect(chunk.reference).toBe("§3.2 Additional internet blocks");
    expect(chunk.text).toContain("Each additional 10 GB block costs $10");
    expect(chunk.text).not.toContain("**");
  });

  it("reads the document metadata", () => {
    expect(index.document).toBe("Mobile_Provider_Billing_Guide.md");
    expect(index.documentId).toBe("MOB-BILLING-2026-01");
  });

  it("makes a section without subsections one chunk", () => {
    const scope = index.chunks.find((c) => c.section === "1")!;
    expect(scope.heading).toBe("Scope and terminology");
    expect(scope.parentHeading).toBeNull();
    expect(scope.text).toContain("Subscriber number");
  });

  it("does not treat headings inside code fences as sections", () => {
    const md = "## 1. Real\n\nIntro.\n\n```\n## 2. Not a heading\n```\n\n### 1.1 Sub\n\nBody.";
    const chunks = chunkMarkdown(md);
    expect(chunks.map((c) => [c.section, c.heading])).toEqual([
      ["1", "Real"],
      ["1.1", "Sub"],
    ]);
    expect(chunks[0]!.text).toContain("## 2. Not a heading");
  });

  it("drops the preamble before the first section", () => {
    const chunks = chunkMarkdown("# Title\n\n**Document ID:** X\n\n## 1. First\n\nText.");
    expect(chunks).toEqual([new Chunk("1", "First", null, "Text.")]);
  });

  it.each([
    ["charge", "charges", "charged", "charging"],
    ["payment", "payments"],
    ["minute", "minutes"],
    ["rule", "rules"],
  ])("stems word forms to one stem: %s", (...words: string[]) => {
    expect(new Set(words.map((w) => stem(w))).size).toBe(1);
  });

  it("tokenize drops stopwords and punctuation", () => {
    expect(tokenize("What is the cost of extra internet?")).toEqual(["cost", "extra", "internet"]);
  });

  it("returns nothing for an unrelated query", () => {
    expect(index.search("pizza recipe")).toEqual([]);
  });

  it("respects max_results", () => {
    expect(index.search("bill payment internet phone", 5)).toHaveLength(5);
    expect(index.search("bill payment internet phone", 1)).toHaveLength(1);
  });
});
