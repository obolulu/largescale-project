"""Retrieval quality on the queries the README documents.

The first three are the required "three distinct retrieval queries"; the rest
are the questions the agent scenarios will ask.
"""

import pytest

from billing_docs.indexer import BillingIndex

# query -> (acceptable top section(s), section that must appear in the top 3)
CASES = {
    "extra internet price": ({"8.1", "3.2"}, "3.2"),
    "partial payment rules": ({"5.1"}, "5.1"),
    "late payment penalty": ({"6.2"}, "6.3"),
    "How much does extra internet cost?": ({"8.1", "3.2"}, "3.2"),
    "Why is my bill higher this month?": ({"8.2"}, "8.2"),
    "Can I pay only part of my bill?": ({"8.3", "5.1"}, "5.1"),
    "How can I dispute a charge?": ({"8.4", "7.1"}, "7.1"),
    "When is my bill due?": ({"6.1"}, "6.1"),
    "free phone minutes": ({"2.1"}, "2.1"),
}


@pytest.fixture(scope="module")
def index() -> BillingIndex:
    return BillingIndex.from_file()


@pytest.mark.parametrize("query", CASES)
def test_query_finds_expected_sections(index, query):
    top_choices, must_include = CASES[query]
    sections = [h.chunk.section for h in index.search(query)]
    assert sections, f"no results for {query!r}"
    assert sections[0] in top_choices, f"{query!r} ranked {sections}"
    assert must_include in sections, f"{query!r} ranked {sections}"


def test_late_payment_answer_says_no_fee(index):
    """The honest answer to 'late payment penalty' is that the reminder adds no fee (§6.2)."""
    top = index.search("late payment penalty")[0].chunk
    assert "does not add a fee" in top.text


def test_synonyms_bridge_user_wording(index):
    # The guide never says "data" or "price"; it says "internet" and "costs".
    assert index.search("extra data price")[0].chunk.section in {"8.1", "3.2"}
