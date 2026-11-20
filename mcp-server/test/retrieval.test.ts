/**
 * Retrieval quality on the queries the README documents.
 *
 * The first three are the required "three distinct retrieval queries"; the rest
 * are the questions the agent scenarios will ask.
 */

import { describe, expect, it } from "vitest";

import { BillingIndex } from "../src/indexer.ts";

// query -> [acceptable top section(s), section that must appear in the top 3]
const CASES: [query: string, top: string[], mustInclude: string][] = [
  ["extra internet price", ["8.1", "3.2"], "3.2"],
  ["partial payment rules", ["5.1"], "5.1"],
  ["late payment penalty", ["6.2"], "6.3"],
  ["How much does extra internet cost?", ["8.1", "3.2"], "3.2"],
  ["Why is my bill higher this month?", ["8.2"], "8.2"],
  ["Can I pay only part of my bill?", ["8.3", "5.1"], "5.1"],
  ["How can I dispute a charge?", ["8.4", "7.1"], "7.1"],
  ["When is my bill due?", ["6.1"], "6.1"],
  ["free phone minutes", ["2.1"], "2.1"],
];

const index = BillingIndex.fromFile();

describe("retrieval", () => {
  it.each(CASES)("%s finds the expected sections", (query, top, mustInclude) => {
    const sections = index.search(query).map((h) => h.chunk.section);
    expect(sections, `no results for ${query}`).not.toHaveLength(0);
    expect(top, `${query} ranked ${sections}`).toContain(sections[0]);
    expect(sections, `${query} ranked ${sections}`).toContain(mustInclude);
  });

  it("answers 'late payment penalty' with the no-fee reminder (§6.2)", () => {
    const top = index.search("late payment penalty")[0]!.chunk;
    expect(top.text).toContain("does not add a fee");
  });

  it("bridges user wording with synonyms", () => {
    // The guide never says "data" or "price"; it says "internet" and "costs".
    expect(["8.1", "3.2"]).toContain(index.search("extra data price")[0]!.chunk.section);
  });
});
