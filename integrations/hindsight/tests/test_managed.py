from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest
from hindsight_api.models import RequestContext
from starlette.responses import JSONResponse

from kulo_hindsight.extensions import KuloOperationValidator, KuloTenantExtension
from kulo_hindsight.managed import load_runtime
from kulo_hindsight.middleware import KuloAccessMiddleware
from kulo_hindsight.policy import AccessPolicy


def test_private_runtime_config_and_no_dotenv(tmp_path):
    config = tmp_path / "runtime.json"
    value = {"owner": "kulo-managed-hindsight-v1", "env": {"HINDSIGHT_API_HOST": "127.0.0.1", "HINDSIGHT_API_LLM_API_KEY": "test-private"}}
    config.write_text(json.dumps(value))
    config.chmod(0o600)
    assert load_runtime(config) == value["env"]
    config.chmod(0o644)
    with pytest.raises(ValueError, match="private regular"):
        load_runtime(config)
    config.chmod(0o600)
    linked = tmp_path / "linked.json"
    linked.symlink_to(config)
    with pytest.raises(ValueError, match="private regular"):
        load_runtime(linked)
    value["env"]["HINDSIGHT_API_HOST"] = "0.0.0.0"
    config.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="loopback"):
        load_runtime(config)


def test_management_identity_is_independent():
    router, worker, manager = ("test-router-" + "r" * 32, "test-worker-" + "w" * 32, "test-manager-" + "m" * 32)
    policy = AccessPolicy(router, worker, management_key=manager)
    assert policy.role_for_key(manager) == "manager"
    assert manager not in repr(policy)
    with pytest.raises(ValueError, match="different"):
        AccessPolicy(router, worker, management_key=router)


async def test_management_is_narrow_and_never_expands_runtime_credentials():
    policy = AccessPolicy("test-router-" + "r" * 32, "test-worker-" + "w" * 32, management_key="test-manager-" + "m" * 32)
    called = []

    async def backend(scope, receive, send):
        called.append(scope["path"])
        await JSONResponse({"ok": True})(scope, receive, send)

    app = KuloAccessMiddleware(backend, policy=policy)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://memory") as client:
        for key in (policy.router_key, policy.worker_key):
            for method, suffix in (("PATCH", "/config"), ("DELETE", "/documents/smoke-test")):
                assert (await client.request(method, "/v1/default/banks/kulo-shared" + suffix, headers={"Authorization": f"Bearer {key}"}, json={})).status_code == 403
        manager = {"Authorization": f"Bearer {policy.management_key}"}
        assert (await client.patch("/v1/default/banks/kulo-shared/config", headers=manager, json={})).status_code == 200
        assert (await client.delete("/v1/default/banks/kulo-shared/documents/smoke-test", headers=manager)).status_code == 200
        for path in ("/v1/default/banks/other/config", "/v1/default/banks", "/metrics", "/mcp/"):
            assert (await client.get(path, headers=manager)).status_code == 403
    assert len(called) == 2
    tenant = KuloTenantExtension({}, policy=policy)
    assert "retain_strategies" in await tenant.get_allowed_config_fields(RequestContext(api_key=policy.management_key), "kulo-shared")
    assert await tenant.get_allowed_config_fields(RequestContext(api_key=policy.worker_key), "kulo-shared") == set()
    validator = KuloOperationValidator({}, policy=policy)
    update = SimpleNamespace(bank_id="kulo-shared", operation="update_bank_config", request_context=RequestContext(api_key=policy.management_key))
    assert (await validator.validate_bank_write(update)).allowed
    update.request_context = RequestContext(api_key=policy.worker_key)
    assert not (await validator.validate_bank_write(update)).allowed
