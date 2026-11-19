import yaml

from app.main import app
from scripts.export_openapi import SPEC_PATH


def test_committed_openapi_spec_is_current():
    assert SPEC_PATH.exists(), "Run: python -m scripts.export_openapi"
    committed = yaml.safe_load(SPEC_PATH.read_text(encoding="utf-8"))
    assert committed == app.openapi(), "docs/openapi.yaml is stale. Run: python -m scripts.export_openapi"


def test_all_operations_are_versioned():
    paths = app.openapi()["paths"]
    assert paths
    assert all(p.startswith("/api/v1/") for p in paths)


def test_protected_operations_declare_bearer_auth():
    paths = app.openapi()["paths"]
    protected = [
        ("/api/v1/usage", "post"),
        ("/api/v1/bills/calculate", "post"),
        ("/api/v1/bills/detailed", "get"),
        ("/api/v1/payments", "post"),
    ]
    for path, method in protected:
        assert paths[path][method].get("security"), f"{method.upper()} {path} has no security"
    assert not paths["/api/v1/bills"]["get"].get("security")
