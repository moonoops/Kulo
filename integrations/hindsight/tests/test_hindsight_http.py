"""Real Hindsight routes and PostgreSQL; no Moco tool wrapper participates."""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
import secrets
import socket
import sys
import uuid

import httpx
import pytest

from moco_hindsight.app import secure_app
from moco_hindsight.extensions import MocoOperationValidator, MocoTenantExtension
from moco_hindsight.policy import AccessPolicy
from moco_hindsight.database import verify_password_authentication


def configure_offline_models(monkeypatch):
    # Test-only credentials and an unreachable model endpoint: admission and
    # document/page operations must work without making a paid model request.
    monkeypatch.setenv("HINDSIGHT_API_LLM_PROVIDER", "openai")
    monkeypatch.setenv("HINDSIGHT_API_LLM_API_KEY", "test-offline-only")
    monkeypatch.setenv("HINDSIGHT_API_LLM_MODEL", "test-offline")
    monkeypatch.setenv("HINDSIGHT_API_LLM_BASE_URL", "http://127.0.0.1:1/v1")
    monkeypatch.setenv("HINDSIGHT_API_RERANKER_PROVIDER", "rrf")
    monkeypatch.setenv("HINDSIGHT_API_SKIP_LLM_VERIFICATION", "true")
    monkeypatch.setenv("HINDSIGHT_API_TEXT_SEARCH_EXTENSION", "native")
    monkeypatch.setenv("HINDSIGHT_API_MIGRATION_ISOLATION", "false")
    monkeypatch.setenv("HINDSIGHT_API_LOG_LEVEL", "ERROR")
    monkeypatch.setenv("HINDSIGHT_API_WORKER_MAX_SLOTS", "2")
    monkeypatch.setenv("HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS", "1")
    monkeypatch.delenv("HINDSIGHT_API_READ_DATABASE_URL", raising=False)
    monkeypatch.delenv("HINDSIGHT_API_MIGRATION_DATABASE_URL", raising=False)
    from hindsight_api.config import clear_config_cache

    clear_config_cache()


def test_production_factory_accepts_authenticated_embedded_database(monkeypatch):
    configure_offline_models(monkeypatch)
    monkeypatch.setenv("MOCO_HINDSIGHT_ROUTER_API_KEY", "test-router-" + "r" * 32)
    monkeypatch.setenv("MOCO_HINDSIGHT_WORKER_API_KEY", "test-worker-" + "w" * 32)
    monkeypatch.setenv("HINDSIGHT_API_DATABASE_URL", "pg0://moco:independent-database-password-00000000@moco-test")
    from hindsight_api.config import clear_config_cache
    from moco_hindsight.app import create_app

    clear_config_cache()
    try:
        app = create_app()
        assert any(getattr(route, "path", "") == "/version" for route in app.routes)
    finally:
        clear_config_cache()


async def test_real_hindsight_routes_reject_every_private_route(monkeypatch):
    configure_offline_models(monkeypatch)
    from hindsight_api import MemoryEngine

    policy = AccessPolicy("test-router-" + "r" * 32, "test-worker-" + "w" * 32)
    # No database connection is needed for a refusal. Using the real engine and
    # route table also catches routes that do not call an operation validator.
    memory = MemoryEngine(
        db_url="postgresql://test:test-offline-database-password-00000000@127.0.0.1:1/test",
        tenant_extension=MocoTenantExtension({}, policy=policy),
        operation_validator=MocoOperationValidator({}, policy=policy),
        skip_llm_verification=True,
        run_migrations=False,
    )
    app = secure_app(memory, policy=policy, initialize_memory=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://memory") as client:
        checked = 0
        for route in app.routes:
            path = getattr(route, "path", "")
            if "{bank_id}" not in path:
                continue
            path = path.replace("{bank_id}", policy.private_bank)
            import re

            path = re.sub(r"\{[^}]+\}", "known-private-id", path)
            for method in getattr(route, "methods", set()):
                response = await client.request(method, path, headers={"Authorization": f"Bearer {policy.worker_key}"}, json={})
                assert response.status_code == 403, (method, path, response.status_code)
                checked += 1
        assert checked >= 90
        assert (await client.get("/v1/default/banks", headers={"Authorization": f"Bearer {policy.worker_key}"})).status_code == 403
        version = await client.get("/version", headers={"Authorization": f"Bearer {policy.worker_key}"})
        assert version.status_code == 200


@pytest.mark.integration
async def test_real_postgres_and_tcp_private_canary_shared_read_write(monkeypatch, tmp_path):
    configure_offline_models(monkeypatch)
    from hindsight_api import MemoryEngine
    from hindsight_api.engine.cross_encoder import RRFPassthroughCrossEncoder
    from hindsight_api.engine.embeddings import Embeddings
    from hindsight_api.extensions import OperationValidationError
    from hindsight_api.models import RequestContext
    from pg0 import Pg0
    import uvicorn

    class OfflineEmbeddings(Embeddings):
        @property
        def provider_name(self):
            return "test"

        @property
        def dimension(self):
            return 8

        async def initialize(self):
            pass

        async def encode(self, texts):
            return [[1.0] + [0.0] * 7 for _ in texts]

    policy = AccessPolicy("test-router-" + "r" * 32, "test-worker-" + "w" * 32, management_key="test-manager-" + "m" * 32)
    pg = Pg0(name="moco-auth-" + uuid.uuid4().hex, username="moco_auth_test", password=secrets.token_hex(24), data_dir=str(tmp_path / "postgres"))
    info = await asyncio.to_thread(pg.start)
    memory = None
    server = None
    server_task = None
    try:
        await verify_password_authentication(info.uri)
        memory = MemoryEngine(
            db_url=info.uri,
            embeddings=OfflineEmbeddings(),
            cross_encoder=RRFPassthroughCrossEncoder(),
            tenant_extension=MocoTenantExtension({}, policy=policy),
            operation_validator=MocoOperationValidator({}, policy=policy),
            skip_llm_verification=True,
        )
        await memory.initialize()
        await memory.ensure_bank_profile(policy.private_bank, request_context=RequestContext(api_key=policy.router_key))
        await memory.ensure_bank_profile(policy.shared_bank, request_context=RequestContext(api_key=policy.worker_key))
        private_canary = "PRIVATE-CANARY-" + uuid.uuid4().hex
        shared_canary = "SHARED-CONTROL-" + uuid.uuid4().hex
        pool = await memory._get_pool()
        async with pool.acquire() as conn:
            for bank, content in ((policy.private_bank, private_canary), (policy.shared_bank, shared_canary)):
                await conn.execute(
                    "INSERT INTO public.documents (id, bank_id, original_text, content_hash) VALUES ($1,$2,$3,$4)",
                    "canary-document", bank, content, hashlib.sha256(content.encode()).hexdigest(),
                )
        private_page = await memory.create_page(
            policy.private_bank,
            "Private page canary",
            "Private test document",
            private_canary,
            request_context=RequestContext(api_key=policy.router_key),
        )
        assert private_page is not None

        # The engine-level hook is independent of HTTP admission and sees the
        # canonical bank even when called by an internal route after alias lookup.
        with pytest.raises(OperationValidationError) as denied:
            await memory.list_documents(policy.private_bank, request_context=RequestContext(api_key=policy.worker_key))
        assert denied.value.status_code == 403

        app = secure_app(memory, policy=policy, initialize_memory=False)
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        config = uvicorn.Config(app, lifespan="off", log_level="error", access_log=False)
        server = uvicorn.Server(config)
        server_task = asyncio.create_task(server.serve(sockets=[sock]))
        for _ in range(200):
            if server.started:
                break
            if server_task.done():
                await server_task
            await asyncio.sleep(0.01)
        assert server.started
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as client:
            router = {"Authorization": f"Bearer {policy.router_key}"}
            worker = {"Authorization": f"Bearer {policy.worker_key}"}
            priv = f"/v1/default/banks/{policy.private_bank}"
            shared = f"/v1/default/banks/{policy.shared_bank}"
            manager = {"Authorization": f"Bearer {policy.management_key}"}
            configured = await client.patch(shared + "/config", headers=manager, json={"updates": {
                "retain_extraction_mode": "concise", "store_document_text": True,
                "enable_observations": True, "enable_auto_consolidation": True,
                "retain_strategies": {"document": {"retain_extraction_mode": "concise"}, "conversation": {"retain_extraction_mode": "concise"}, "worklog": {"retain_extraction_mode": "concise"}},
            }})
            assert configured.status_code == 200, configured.text
            assert (await client.get(shared + "/config", headers=manager)).status_code == 200
            assert (await client.patch(shared + "/config", headers=worker, json={"updates": {"enable_observations": False}})).status_code == 403
            assert (await client.get(shared + "/config", headers=router)).status_code == 403
            root_read = await client.get(priv + "/documents/canary-document", headers=router)
            assert root_read.status_code == 200, root_read.text
            assert private_canary in root_read.text
            shared_read = await client.get(shared + "/documents/canary-document", headers=worker)
            assert shared_read.status_code == 200, shared_read.text
            assert shared_canary in shared_read.text and private_canary not in shared_read.text
            denied_read = await client.get(priv + "/documents/canary-document", headers=worker)
            assert denied_read.status_code == 403
            assert private_canary not in denied_read.text
            assert (await client.get(priv + "/documents/canary-document")).status_code == 401
            for suffix in ("/documents", "/knowledge-base/tree", "/knowledge-base/pages/private-page", "/operations/private-operation", "/export"):
                response = await client.get(priv + suffix, headers=worker)
                assert response.status_code == 403 and private_canary not in response.text
            for suffix in ("/memories/recall", "/reflect", "/memories"):
                assert (await client.post(priv + suffix, headers=worker, json={})).status_code == 403
            assert (await client.post(shared + "/memories", headers=router, json={})).status_code == 403
            page_read = await client.get(priv + "/knowledge-base/pages/" + private_page["id"], headers=router)
            assert page_read.status_code == 200 and private_canary in page_read.text
            wrong_bank_page = await client.get(shared + "/knowledge-base/pages/" + private_page["id"], headers=worker)
            assert wrong_bank_page.status_code == 404 and private_canary not in wrong_bank_page.text

            # Exercise the same asynchronous retain endpoint used by Moco,
            # without running the model-processing worker in this fixture.
            shared_retain = await client.post(shared + "/memories", headers=worker, json={"async": True, "operation_id": str(uuid.uuid4()), "items": [{"content": "Moco 安装验证项目的名称是 Shared queued write control，由 Moco 负责验证，验证语言是简体中文。", "document_id": "queued-shared", "tags": ["application:moco", "verification:installation"], "observation_scopes": [["verification:installation"]]}]})
            assert shared_retain.status_code in {200, 202}, shared_retain.text
            shared_operation = shared_retain.json()["operation_id"]
            assert (await client.get(shared + "/operations/" + shared_operation, headers=worker)).status_code == 200
            private_retain = await client.post(priv + "/memories", headers=router, json={"async": True, "items": [{"content": private_canary, "document_id": "queued-private"}]})
            assert private_retain.status_code in {200, 202}, private_retain.text
            private_operation = private_retain.json()["operation_id"]
            wrong_bank_operation = await client.get(shared + "/operations/" + private_operation + "?include_payload=true", headers=worker)
            assert wrong_bank_operation.status_code == 200
            assert wrong_bank_operation.json()["status"] == "not_found"
            assert private_canary not in wrong_bank_operation.text

            # Folder creation has no model call and commits immediately to the
            # real database, providing a positive shared-write/read control.
            created = await client.post(shared + "/knowledge-base/folders", headers=worker, json={"name": "Shared write control"})
            assert created.status_code == 201, created.text
            tree = await client.get(shared + "/knowledge-base/tree", headers=worker)
            assert tree.status_code == 200 and "Shared write control" in tree.text

            # Step 6: Verify /pages/* canonical endpoints, export block, and Project A vs Project B tag isolation on shared bank
            assert (await client.get(shared + "/pages/export", headers=worker)).status_code == 403
            assert (await client.get(shared + "/knowledge-base/export", headers=worker)).status_code == 403
            assert (await client.patch(shared + "/memories/nonexistent", headers=worker, json={"state": "invalidated"})).status_code == 403
            assert (await client.post(shared + "/mental-models", headers=worker, json={"name": "Blocked", "source_query": "q"})).status_code == 403

            page_a = await memory.create_page(
                policy.shared_bank,
                "Project Alpha Architecture",
                "Summarize Alpha",
                "ALPHA-SECRET-SPEC",
                tags=["project:proj-alpha"],
                request_context=RequestContext(api_key=policy.worker_key),
            )
            page_b = await memory.create_page(
                policy.shared_bank,
                "Project Beta Architecture",
                "Summarize Beta",
                "BETA-SECRET-SPEC",
                tags=["project:proj-beta"],
                request_context=RequestContext(api_key=policy.worker_key),
            )
            tree_a = await client.get(shared + "/pages/tree", params={"tags": ["project:proj-alpha"], "tags_match": "all_strict"}, headers=worker)
            assert tree_a.status_code == 200, tree_a.text
            assert "Project Alpha Architecture" in tree_a.text
            assert "Project Beta Architecture" not in tree_a.text

            tree_b = await client.get(shared + "/pages/tree", params={"tags": ["project:proj-beta"], "tags_match": "all_strict"}, headers=worker)
            assert tree_b.status_code == 200, tree_b.text
            assert "Project Beta Architecture" in tree_b.text
            assert "Project Alpha Architecture" not in tree_b.text

            patched_node = await client.patch(
                shared + "/pages/nodes/" + page_a["id"],
                headers=worker,
                json={"name": "Project Alpha Architecture v2"},
            )
            assert patched_node.status_code == 200, patched_node.text
            assert patched_node.json()["name"] == "Project Alpha Architecture v2"
            assert page_b["id"] != page_a["id"]
            private_write = await client.post(priv + "/knowledge-base/folders", headers=router, json={"name": "Private write control"})
            assert private_write.status_code == 201, private_write.text
            deleted = await client.delete(shared + "/documents/canary-document", headers=manager)
            assert deleted.status_code == 200, deleted.text
            assert (await client.get(shared + "/documents/canary-document", headers=worker)).status_code == 404
            assert (await client.get("/v1/moco/access", headers=worker)).json() == policy.describe("worker")
            if sys.platform == "darwin":
                repo = Path(__file__).resolve().parents[3]
                local_tsx = repo / "node_modules" / ".bin" / ("tsx.cmd" if sys.platform == "win32" else "tsx")
                probe_cmd = (
                    [str(local_tsx), "tests/helpers/memory-worker-probe.ts"]
                    if local_tsx.exists()
                    else ["pnpm", "exec", "tsx", "tests/helpers/memory-worker-probe.ts"]
                )
                probe = await asyncio.create_subprocess_exec(
                    *probe_cmd,
                    cwd=repo, stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                output, errors = await asyncio.wait_for(probe.communicate(json.dumps({
                    "baseUrl": f"http://127.0.0.1:{port}",
                    "workerKey": policy.worker_key,
                    "privateBank": policy.private_bank,
                    "sharedBank": policy.shared_bank,
                    "workspaceDir": str(tmp_path / "worker-workspace"),
                }).encode()), timeout=90)
                assert probe.returncode == 0, errors.decode().replace(policy.worker_key, "[REDACTED]")
                assert json.loads(output) == {
                    "privateStatus": 403, "sharedStatus": 200, "sharedWriteStatus": 201,
                    "privateFileDenied": True, "routerEnvironmentDenied": True,
                }
    finally:
        if server is not None:
            server.should_exit = True
        if server_task is not None:
            await server_task
        if memory is not None:
            await memory.close()
        await asyncio.to_thread(pg.stop)


@pytest.mark.integration
async def test_official_worker_completes_retention_and_other_worker_recalls_it(monkeypatch, tmp_path):
    """Exercise the official queue/model pipeline, with its own deterministic model."""
    configure_offline_models(monkeypatch)
    monkeypatch.setenv("HINDSIGHT_API_LLM_PROVIDER", "mock")
    monkeypatch.setenv("HINDSIGHT_API_WORKER_POLL_INTERVAL_MS", "50")
    monkeypatch.setenv("HINDSIGHT_API_WORKER_SHUTDOWN_DRAIN_SECONDS", "1")
    monkeypatch.setenv("HINDSIGHT_API_LLM_TRACE_ENABLED", "false")
    from hindsight_api.config import clear_config_cache
    from hindsight_api import MemoryEngine
    from hindsight_api.engine.cross_encoder import RRFPassthroughCrossEncoder
    from hindsight_api.engine.embeddings import Embeddings
    from pg0 import Pg0
    import uvicorn

    clear_config_cache()

    class OfflineEmbeddings(Embeddings):
        @property
        def provider_name(self):
            return "test"

        @property
        def dimension(self):
            return 8

        async def initialize(self):
            pass

        async def encode(self, texts):
            return [[1.0] + [0.0] * 7 for _ in texts]

    policy = AccessPolicy("test-router-" + "r" * 32, "test-worker-" + "w" * 32, management_key="test-manager-" + "m" * 32)
    pg = Pg0(name="moco-pipeline-" + uuid.uuid4().hex, username="moco_pipeline", password=secrets.token_hex(24), data_dir=str(tmp_path / "postgres"))
    info = await asyncio.to_thread(pg.start)
    memory = server = task = None
    try:
        memory = MemoryEngine(db_url=info.uri, memory_llm_provider="mock", embeddings=OfflineEmbeddings(), cross_encoder=RRFPassthroughCrossEncoder(), tenant_extension=MocoTenantExtension({}, policy=policy), operation_validator=MocoOperationValidator({}, policy=policy), skip_llm_verification=True)
        await memory.initialize()
        app = secure_app(memory, policy=policy, initialize_memory=False)
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, lifespan="on", log_level="error", access_log=False))
        task = asyncio.create_task(server.serve(sockets=[sock]))
        for _ in range(300):
            if server.started:
                break
            if task.done():
                await task
            await asyncio.sleep(0.01)
        assert server.started
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=20) as client:
            worker = {"Authorization": f"Bearer {policy.worker_key}"}
            manager = {"Authorization": f"Bearer {policy.management_key}"}
            prefix = f"/v1/default/banks/{policy.shared_bank}"
            setup = await client.patch(prefix + "/config", headers=manager, json={"updates": {"retain_extraction_mode": "concise", "store_document_text": True, "enable_auto_consolidation": False, "retain_strategies": {"worklog": {"retain_extraction_mode": "concise"}}}})
            assert setup.status_code == 200, setup.text
            marker = "WORKER-A-VERIFIED-" + uuid.uuid4().hex
            operation_id = str(uuid.uuid4())
            body = {"async": True, "operation_id": operation_id, "items": [{"content": f"Worker A verified that the shared project uses the marker {marker}. This result was validated by its test suite.", "document_id": "task-a-worklog", "strategy": "worklog", "tags": ["application:moco", "verification:installation"], "observation_scopes": [["verification:installation"]]}]}
            retained = await client.post(prefix + "/memories", headers=worker, json=body)
            assert retained.status_code in (200, 202), retained.text
            replayed = await client.post(prefix + "/memories", headers=worker, json=body)
            assert replayed.json()["operation_id"] == retained.json()["operation_id"] == operation_id
            final = None
            for _ in range(200):
                final = await client.get(prefix + "/operations/" + operation_id, headers=worker)
                assert final.status_code == 200
                if final.json()["status"] in {"completed", "failed", "cancelled"}:
                    break
                await asyncio.sleep(0.05)
            assert final is not None and final.json()["status"] == "completed", final.text if final else "missing operation"
            recall = await client.post(prefix + "/memories/recall", headers=worker, json={"query": marker, "budget": "low", "max_tokens": 500, "tags": ["verification:installation"], "tags_match": "all_strict"})
            assert recall.status_code == 200, recall.text
            assert marker in recall.text
            reflected = await client.post(prefix + "/reflect", headers=worker, json={"query": "What project result did Worker A validate?", "budget": "low", "max_tokens": 300, "tags": ["verification:installation"], "tags_match": "all_strict"})
            assert reflected.status_code == 200 and reflected.json()["text"], reflected.text
            assert (await client.post(f"/v1/default/banks/{policy.private_bank}/memories/recall", headers=worker, json={"query": marker})).status_code == 403
            assert (await client.delete(prefix + "/documents/task-a-worklog", headers=worker)).status_code == 403
            assert (await client.delete(prefix + "/documents/task-a-worklog", headers=manager)).status_code == 200
    finally:
        if server is not None:
            server.should_exit = True
        if task is not None:
            await task
        elif memory is not None:
            await memory.close()
        await asyncio.to_thread(pg.stop)
        clear_config_cache()

