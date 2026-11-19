"""Chunk the billing guide by section and search it with BM25 full-text ranking.

Indexing happens once, when BillingIndex is built (at server startup). A search
only tokenizes the query and scores the prebuilt postings; it never re-reads or
re-indexes the document.

Chunking: one chunk per `###` subsection (e.g. 3.2 "Additional internet blocks").
A `##` section's own text before its first `###` (or a `##` section with no
subsections, like §1 and §9) becomes a chunk under the `##` number. Each chunk
keeps its section ID, heading and parent heading so answers can cite "§3.2".
"""

from __future__ import annotations

import math
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_GUIDE = Path(__file__).resolve().parent.parent / "data" / "Mobile_Provider_Billing_Guide.md"

_HEADING = re.compile(r"^(#{2,3})\s+(\d+(?:\.\d+)?)\.?\s+(.+?)\s*$")
_DOC_ID = re.compile(r"\*\*Document ID:\*\*\s*(\S+)")
_TOKEN = re.compile(r"[a-z0-9]+")

# Common words that carry no meaning for retrieval.
STOPWORDS = frozenset(
    """a an and are as at be been but by can do does for from has have how i if in into is it its
    me my of on or our so than that the their them then there these this to was what when where
    which who why will with you your""".split()
)

# Query-side synonyms for billing vocabulary, so "extra data price" finds
# "additional internet blocks ... costs". Expansions score at half weight.
SYNONYMS: dict[str, tuple[str, ...]] = {
    "extra": ("additional",),
    "additional": ("extra",),
    "data": ("internet",),
    "price": ("cost", "charge"),
    "cost": ("price", "charge"),
    "charge": ("cost", "price", "fee"),
    "fee": ("charge",),
    "penalty": ("fee", "late"),
    "overdue": ("late", "unpaid"),
    "late": ("overdue",),
    "part": ("partial",),
    "partial": ("part",),
    "installment": ("partial",),
    "pay": ("payment",),
    "paid": ("payment",),
    "invoice": ("bill",),
    "complaint": ("dispute",),
    "refund": ("dispute", "adjustment"),
    "call": ("phone", "minute"),
    "minute": ("phone",),
    "allowance": ("included",),
    "deadline": ("due",),
    "suspend": ("restriction",),
    "suspension": ("restriction",),
    "cut": ("restriction",),
}

EXPANSION_WEIGHT = 0.5
HEADING_WEIGHT = 2  # heading tokens count this many times in a chunk


def _stem(token: str) -> str:
    """Tiny suffix stripper so charge/charges/charged/charging share one form."""
    for suffix in ("ing", "ies", "ed", "es", "s"):
        if len(token) > len(suffix) + 2 and token.endswith(suffix) and not token.endswith("ss"):
            token = token[: -len(suffix)] + ("y" if suffix == "ies" else "")
            break
    if len(token) > 3 and token.endswith("e"):
        token = token[:-1]
    return token


def tokenize(text: str) -> list[str]:
    return [_stem(t) for t in _TOKEN.findall(text.lower()) if t not in STOPWORDS]


# Synonyms keyed and valued by stem, so "charges" and "charge" expand the same way.
_STEM_SYNONYMS: dict[str, tuple[str, ...]] = {}
for _word, _syns in SYNONYMS.items():
    _key = _stem(_word)
    _STEM_SYNONYMS[_key] = tuple(dict.fromkeys(_STEM_SYNONYMS.get(_key, ()) + tuple(_stem(s) for s in _syns)))


@dataclass(frozen=True)
class Chunk:
    section: str  # "3.2"
    heading: str  # "Additional internet blocks"
    parent_heading: str | None  # "Internet pricing" (None for a top-level section)
    text: str  # body text with markdown emphasis removed

    @property
    def reference(self) -> str:
        return f"§{self.section} {self.heading}"


def _clean(lines: list[str]) -> str:
    text = "\n".join(lines).strip()
    text = text.replace("**", "")
    return re.sub(r"\n{3,}", "\n\n", text)


def chunk_markdown(markdown: str) -> list[Chunk]:
    chunks: list[Chunk] = []
    top: tuple[str, str] | None = None  # current ## (number, title)
    current: tuple[str, str, str | None] | None = None  # (section, heading, parent)
    body: list[str] = []
    in_code = False

    def flush() -> None:
        if current is not None:
            text = _clean(body)
            if text:
                chunks.append(Chunk(current[0], current[1], current[2], text))

    for line in markdown.splitlines():
        if line.lstrip().startswith("```"):
            in_code = not in_code
        match = None if in_code else _HEADING.match(line)
        if match is None:
            if current is not None:
                body.append(line)
            continue

        flush()
        body = []
        level, number, title = match.groups()
        if level == "##":
            top = (number, title)
            current = (number, title, None)
        else:
            current = (number, title, top[1] if top else None)
    flush()
    return chunks


@dataclass
class SearchHit:
    chunk: Chunk
    score: float


@dataclass
class BillingIndex:
    """BM25 (k1=1.5, b=0.75) over section chunks, built once."""

    document: str
    document_id: str | None
    chunks: list[Chunk]
    k1: float = 1.5
    b: float = 0.75
    build_ms: float = 0.0
    _tf: list[Counter[str]] = field(default_factory=list, repr=False)
    _len: list[int] = field(default_factory=list, repr=False)
    _idf: dict[str, float] = field(default_factory=dict, repr=False)
    _avg_len: float = 0.0

    @classmethod
    def from_file(cls, path: Path = DEFAULT_GUIDE) -> BillingIndex:
        markdown = path.read_text(encoding="utf-8")
        return cls.from_markdown(markdown, document=path.name)

    @classmethod
    def from_markdown(cls, markdown: str, document: str) -> BillingIndex:
        started = time.perf_counter()
        doc_id = _DOC_ID.search(markdown)
        index = cls(document=document, document_id=doc_id.group(1) if doc_id else None, chunks=chunk_markdown(markdown))
        index._build()
        index.build_ms = (time.perf_counter() - started) * 1000
        return index

    def _build(self) -> None:
        df: Counter[str] = Counter()
        for chunk in self.chunks:
            tokens = tokenize(chunk.heading) * HEADING_WEIGHT + tokenize(chunk.parent_heading or "") + tokenize(chunk.text)
            tf = Counter(tokens)
            self._tf.append(tf)
            self._len.append(len(tokens))
            df.update(tf.keys())
        n = len(self.chunks)
        self._avg_len = sum(self._len) / n if n else 0.0
        self._idf = {term: math.log(1 + (n - d + 0.5) / (d + 0.5)) for term, d in df.items()}

    def _query_weights(self, query: str) -> dict[str, float]:
        weights: dict[str, float] = {}
        for raw in _TOKEN.findall(query.lower()):
            if raw in STOPWORDS:
                continue
            stem = _stem(raw)
            weights[stem] = 1.0
            for syn in _STEM_SYNONYMS.get(stem, ()):
                weights[syn] = max(weights.get(syn, 0.0), EXPANSION_WEIGHT)
        return weights

    def search(self, query: str, max_results: int = 3) -> list[SearchHit]:
        weights = self._query_weights(query)
        hits: list[SearchHit] = []
        for i, chunk in enumerate(self.chunks):
            tf, length = self._tf[i], self._len[i]
            score = 0.0
            for term, weight in weights.items():
                f = tf.get(term)
                if not f:
                    continue
                norm = f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * length / self._avg_len))
                score += weight * self._idf[term] * norm
            if score > 0:
                hits.append(SearchHit(chunk, score))
        hits.sort(key=lambda h: (-h.score, h.chunk.section))
        return hits[:max_results]
