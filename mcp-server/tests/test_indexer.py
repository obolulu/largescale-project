import pytest

from billing_docs.indexer import BillingIndex, Chunk, _stem, chunk_markdown, tokenize


@pytest.fixture(scope="module")
def index() -> BillingIndex:
    return BillingIndex.from_file()


def test_guide_is_chunked_by_subsection(index):
    sections = [c.section for c in index.chunks]
    assert sections[:4] == ["1", "2.1", "2.2", "2.3"]
    assert "3.2" in sections and "9" in sections
    assert len(sections) == len(set(sections)) == 25


def test_chunks_keep_heading_parent_and_reference(index):
    chunk = next(c for c in index.chunks if c.section == "3.2")
    assert chunk.heading == "Additional internet blocks"
    assert chunk.parent_heading == "Internet pricing"
    assert chunk.reference == "§3.2 Additional internet blocks"
    assert "Each additional 10 GB block costs $10" in chunk.text
    assert "**" not in chunk.text


def test_document_metadata_is_read(index):
    assert index.document == "Mobile_Provider_Billing_Guide.md"
    assert index.document_id == "MOB-BILLING-2026-01"


def test_section_without_subsections_is_one_chunk(index):
    scope = next(c for c in index.chunks if c.section == "1")
    assert scope.heading == "Scope and terminology"
    assert scope.parent_heading is None
    assert "Subscriber number" in scope.text


def test_headings_inside_code_fences_are_not_sections():
    md = "## 1. Real\n\nIntro.\n\n```\n## 2. Not a heading\n```\n\n### 1.1 Sub\n\nBody."
    assert [(c.section, c.heading) for c in chunk_markdown(md)] == [("1", "Real"), ("1.1", "Sub")]
    assert "## 2. Not a heading" in chunk_markdown(md)[0].text


def test_preamble_before_first_section_is_not_a_chunk():
    chunks = chunk_markdown("# Title\n\n**Document ID:** X\n\n## 1. First\n\nText.")
    assert chunks == [Chunk("1", "First", None, "Text.")]


@pytest.mark.parametrize(
    "words",
    [("charge", "charges", "charged", "charging"), ("payment", "payments"), ("minute", "minutes"), ("rule", "rules")],
)
def test_stemming_groups_word_forms(words):
    assert len({_stem(w) for w in words}) == 1


def test_tokenize_drops_stopwords_and_punctuation():
    assert tokenize("What is the cost of extra internet?") == ["cost", "extra", "internet"]


def test_unrelated_query_returns_nothing(index):
    assert index.search("pizza recipe") == []


def test_max_results_is_respected(index):
    assert len(index.search("bill payment internet phone", max_results=5)) == 5
    assert len(index.search("bill payment internet phone", max_results=1)) == 1
