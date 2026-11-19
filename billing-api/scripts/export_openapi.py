"""Write the OpenAPI spec to docs/openapi.yaml (a graded deliverable).

Usage (from billing-api/): python -m scripts.export_openapi
tests/test_openapi.py fails if the committed file is out of date.
"""

from pathlib import Path

import yaml

from app.main import app

SPEC_PATH = Path(__file__).resolve().parents[2] / "docs" / "openapi.yaml"


def render() -> str:
    return yaml.safe_dump(app.openapi(), sort_keys=False, allow_unicode=True)


if __name__ == "__main__":
    SPEC_PATH.write_text(render(), encoding="utf-8")
    print(f"Wrote {SPEC_PATH}")
