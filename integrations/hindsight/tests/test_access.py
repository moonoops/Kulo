from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from hindsight_api.models import RequestContext
from starlette.responses import JSONResponse

from kulo_hindsight.extensions import KuloOperationValidator, KuloTenantExtension
from kulo_hindsight.middleware import KuloAccessMiddleware
from kulo_hindsight.policy import AccessPolicy
from kulo_hindsight.database import database_password, verify_password_authentication


@pytest.fixture
def policy():
    return AccessPolicy("test-router-" + "r" * 32, "test-worker-" + "w" * 32)


@pytest.mark.parametrize("role,bank,write,allowed", [
    ("router", "kulo-core", False, True),
    ("router", "kulo-core", True, True),
    ("router", "kulo-shared", False, True),
    ("router", "kulo-shared", True, False),
    ("worker", "kulo-core", False, False),
    ("worker", "kulo-core", True, False),
    ("worker", "kulo-shared", False, True),
    ("worker", "kulo-shared", True, True),
    ("worker", "other", False, False),
])
def test_policy_matrix(policy, role, bank, write, allowed):
    assert policy.allows(role, bank, write=write) is allowed


def test_policy_requires_distinct_credentials_and_banks(policy):
    with pytest.raises(ValueError, match="keys must be different"):
        AccessPolicy(policy.router_key, policy.router_key)
    with pytest.raises(ValueError, match="bank IDs must be different"):
        AccessPolicy(policy.router_key, policy.worker_key, "shared", "SHARED")
    with pytest.raises(ValueError):
        AccessPolicy(policy.router_key, "")
    assert policy.router_key not in repr(policy)
    assert policy.worker_key not in repr(policy)


@pytest.mark.parametrize("url", [
    "pg0", "pg0://kulo", "postgresql://postgres:postgres@localhost/db",
    "postgresql:///db", "postgresql://user@localhost/db", "postgresql://user:short@localhost/db",
])
def test_public_or_peer_database_credentials_are_rejected(policy, url):
    with pytest.raises(ValueError, match="explicit username") as error:
        database_password(url, policy=policy, setting="HINDSIGHT_API_DATABASE_URL")
    if "://" in url:
        assert url not in str(error.value)


def test_memory_credentials_cannot_be_used_as_database_password(policy):
    for key in (policy.router_key, policy.worker_key):
        with pytest.raises(ValueError):
            database_password(f"postgresql://user:{key}@localhost/db", policy=policy, setting="HINDSIGHT_API_DATABASE_URL")
    assert database_password("pg0://user:independent-database-password-00000000@kulo", policy=policy, setting="HINDSIGHT_API_DATABASE_URL") == "independent-database-password-00000000"


async def test_database_that_ignores_password_is_rejected(monkeypatch):
    import asyncpg

    class TrustConnection:
        closed = False

        async def close(self):
            self.closed = True

    connection = TrustConnection()

    async def accepts_any_password(*args, **kwargs):
        return connection

    monkeypatch.setattr(asyncpg, "connect", accepts_any_password)
    with pytest.raises(RuntimeError, match="incorrect password"):
        await verify_password_authentication("postgresql://user:unimportant@localhost/db")
    assert connection.closed


def test_redaction_preserves_uvicorn_access_log_arguments(policy):
    import io
    import logging
    from uvicorn.logging import AccessFormatter
    from kulo_hindsight.app import _redact_logging

    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(AccessFormatter('%(client_addr)s - "%(request_line)s" %(status_code)s', use_colors=False))
    logger = logging.getLogger("kulo.test.access-redaction")
    logger.addHandler(handler)
    previous_level, previous_propagate = logger.level, logger.propagate
    logger.setLevel(logging.INFO)
    logger.propagate = False
    try:
        _redact_logging((policy.router_key, policy.worker_key))
        logger.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1", "GET", "/token/" + policy.router_key, "1.1", 200)
        output = stream.getvalue()
        assert policy.router_key not in output
        assert "[REDACTED]" in output and "200" in output and "GET" in output
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)
        logger.propagate = previous_propagate


async def test_engine_hooks_check_canonical_bank_and_reject_management(policy):
    validator = KuloOperationValidator({}, policy=policy)
    for name in ("validate_recall", "validate_reflect", "validate_bank_read", "validate_retain", "validate_bank_write", "validate_mental_model_get", "validate_mental_model_refresh", "validate_mental_model_candidate", "validate_memory_update"):
        context = SimpleNamespace(bank_id="kulo-core", request_context=RequestContext(api_key=policy.worker_key), operation="get_document")
        result = await getattr(validator, name)(context)
        assert not result.allowed and result.status_code == 403
    write = SimpleNamespace(bank_id="kulo-shared", request_context=RequestContext(api_key=policy.worker_key), operation="create_bank_alias")
    assert not (await validator.validate_bank_write(write)).allowed
    write.operation = "create_knowledge_page"
    assert (await validator.validate_bank_write(write)).allowed
    write.operation = "update_bank_config"
    assert not (await validator.validate_bank_write(write)).allowed
    assert not (await validator.validate_import(write)).allowed
    tenant = KuloTenantExtension({}, policy=policy)
    assert (await tenant.authenticate(RequestContext(api_key=policy.worker_key))).schema_name == "public"
    assert await tenant.get_allowed_config_fields(None, "kulo-shared") == set()
    write.operation = "new_unreviewed_operation"
    assert not (await validator.precheck(write)).allowed


@pytest.mark.parametrize("method,path", [
    ("GET", "/v1/default/banks/kulo-core/documents"),
    ("GET", "/v1/default/banks/kulo-core/documents/private-document"),
    ("POST", "/v1/default/banks/kulo-core/memories/recall"),
    ("POST", "/v1/default/banks/kulo-core/reflect"),
    ("GET", "/v1/default/banks/kulo-core/knowledge-base/tree"),
    ("GET", "/v1/default/banks/kulo-core/knowledge-base/search"),
    ("GET", "/v1/default/banks/kulo-core/knowledge-base/pages/private-page"),
    ("GET", "/v1/default/banks/kulo-core/operations/private-operation"),
    ("GET", "/v1/default/banks/kulo-core/export"),
    ("GET", "/v1/default/banks"),
    ("GET", "/v1/default/banks/kulo-shared/config"),
    ("POST", "/v1/default/banks/kulo-shared/aliases"),
    ("POST", "/v1/default/banks/kulo-shared/clone?target_bank_id=kulo-core"),
    ("GET", "/v1/default/banks/kulo-shared/export"),
    ("GET", "/v1/default/banks/kulo-shared/pages/export"),
    ("GET", "/v1/default/banks/kulo-shared/knowledge-base/export"),
    ("GET", "/v1/default/banks/kulo-shared/documents/export"),
    ("GET", "/v1/default/banks/kulo-shared/memories/list"),
    ("PATCH", "/v1/default/banks/kulo-shared/memories/unit-123"),
    ("POST", "/v1/default/banks/kulo-shared/mental-models"),
    ("POST", "/v1/default/banks/kulo-shared/mental-models/model-1/refresh"),
    ("POST", "/v1/default/banks/kulo-shared/import"),
    ("GET", "/v1/default/banks/kulo-shared/llm-requests"),
    ("POST", "/mcp/"),
    ("POST", "/mcp/kulo-core/"),
    ("GET", "/metrics"),
    ("GET", "/openapi.json"),
    ("GET", "/v1/default/banks/shared-alias/documents"),
    ("GET", "/v1/default/banks/kulo-shared/../kulo-core/documents"),
    ("GET", "/v1/default/banks/kulo-shared%2f..%2fkulo-core/documents"),
])
async def test_transport_rejects_worker_bypasses_before_backend(policy, method, path):
    called = False

    async def backend(scope, receive, send):
        nonlocal called
        called = True
        await JSONResponse({"private": "must never run"})(scope, receive, send)

    app = KuloAccessMiddleware(backend, policy=policy)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://memory") as client:
        response = await client.request(method, path, headers={"Authorization": f"Bearer {policy.worker_key}", "X-Role": "router"}, json={"role": "router", "bank": "kulo-core"})
    assert response.status_code == 403
    assert not called


async def test_transport_requires_auth_and_allows_shared_controls(policy):
    async def backend(scope, receive, send):
        await JSONResponse({"ok": True})(scope, receive, send)

    app = KuloAccessMiddleware(backend, policy=policy)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://memory") as client:
        assert (await client.get("/v1/default/banks/kulo-core/documents")).status_code == 401
        duplicate = [("Authorization", f"Bearer {policy.worker_key}"), ("Authorization", f"Bearer {policy.router_key}")]
        assert (await client.get("/v1/default/banks/kulo-core/documents", headers=duplicate)).status_code == 401
        for path in ("/documents", "/knowledge-base/tree", "/knowledge-base/pages/known-page", "/pages/tree", "/pages/search", "/pages/known-page", "/mental-models", "/mental-models/known-model"):
            assert (await client.get(f"/v1/default/banks/kulo-shared{path}", headers={"Authorization": f"Bearer {policy.worker_key}"})).status_code == 200
        assert (await client.post("/v1/default/banks/kulo-shared/memories", headers={"Authorization": f"Bearer {policy.worker_key}"}, json={})).status_code == 200
        assert (await client.post("/v1/default/banks/kulo-shared/pages", headers={"Authorization": f"Bearer {policy.worker_key}"}, json={})).status_code == 200
        assert (await client.patch("/v1/default/banks/kulo-shared/pages/nodes/node-1", headers={"Authorization": f"Bearer {policy.worker_key}"}, json={})).status_code == 200
        assert (await client.post("/v1/default/banks/kulo-shared/memories", headers={"Authorization": f"Bearer {policy.router_key}"}, json={})).status_code == 403
        assert (await client.patch("/v1/default/banks/kulo-shared/memories/unit-1", headers={"Authorization": f"Bearer {policy.router_key}"}, json={})).status_code == 403
        assert (await client.patch("/v1/default/banks/kulo-core/memories/unit-1", headers={"Authorization": f"Bearer {policy.router_key}"}, json={})).status_code == 200
        assert (await client.post("/v1/default/banks/kulo-core/mental-models", headers={"Authorization": f"Bearer {policy.router_key}"}, json={})).status_code == 200
        access = await client.get("/v1/kulo/access", headers={"Authorization": f"Bearer {policy.worker_key}"})
        assert access.json() == policy.describe("worker")
        assert policy.router_key not in access.text and policy.worker_key not in access.text

