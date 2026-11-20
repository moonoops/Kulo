"""Unit tests for the Kulo Hub loopback LLM bridge provider."""

from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Thread
from http.server import BaseHTTPRequestHandler, HTTPServer
import pytest
from pydantic import BaseModel

from hindsight_api.engine.llm_interface import (
    LLMToolChoice,
    OutputTooLongError,
    ProviderAuthError,
    ProviderContentPolicyError,
)
from hindsight_api.engine.llm_wrapper import LLMProvider
from kulo_hindsight.bridge import BRIDGE_OWNER, KuloBridgeLLM, load_bridge_config


class SampleFacts(BaseModel):
    facts: list[str]


def _write_bridge(file: Path, url: str, token: str) -> None:
    file.write_text(json.dumps({"owner": BRIDGE_OWNER, "url": url, "token": token}), encoding="utf-8")
    os.chmod(file, 0o600)


def _start_server(handler_cls: type[BaseHTTPRequestHandler]):
    server = HTTPServer(("127.0.0.1", 0), handler_cls)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/api/internal/memory-llm/call"


def test_load_bridge_config_enforces_private_loopback_contract(tmp_path: Path):
    file = tmp_path / "memory-llm-bridge.json"
    _write_bridge(file, "http://127.0.0.1:4100/api/internal/memory-llm/call", "secret-token-123")
    url, token, _ = load_bridge_config(file)
    assert url == "http://127.0.0.1:4100/api/internal/memory-llm/call"
    assert token == "secret-token-123"

    os.chmod(file, 0o644)
    with pytest.raises(ValueError, match="private regular file"):
        load_bridge_config(file)

    os.chmod(file, 0o600)
    link = tmp_path / "link.json"
    link.symlink_to(file)
    with pytest.raises(ValueError, match="private regular file"):
        load_bridge_config(link)

    _write_bridge(file, "http://example.com:4100/api/internal/memory-llm/call", "secret-token-123")
    with pytest.raises(ValueError, match="loopback"):
        load_bridge_config(file)


@pytest.mark.asyncio
async def test_kulo_bridge_llm_loads_via_hindsight_wrapper_and_supports_structured_and_tools(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    received: list[dict] = []
    expected_token = "bridge-token-v1"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def do_POST(self):
            auth = self.headers.get("Authorization")
            if auth != f"Bearer {expected_token}":
                body = json.dumps({"error": {"code": "bridge_unauthorized", "message": "stale token", "retryable": False}}).encode()
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            received.append(payload)
            schema = payload.get("responseSchema")
            if schema and schema.get("name") == "SampleFacts":
                text = "<think>drafting</think>```json\n{\"facts\": [\"uses vertex\"]}\n```"
            elif schema and schema.get("name") == "lookup":
                text = "{\"query\": \"vertex\"}"
            else:
                text = "OK"
            body = json.dumps({
                "text": text,
                "stopReason": "stop",
                "usage": {"inputTokens": 11, "outputTokens": 7, "cachedTokens": 2, "totalTokens": 18},
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server, url = _start_server(Handler)
    try:
        bridge_file = tmp_path / "memory-llm-bridge.json"
        _write_bridge(bridge_file, url, expected_token)
        monkeypatch.setenv("KULO_HINDSIGHT_MODEL_PROVIDER_ID", "api-vertex")
        monkeypatch.setenv("KULO_HINDSIGHT_BRIDGE_FILE", str(bridge_file))

        llm = LLMProvider(
            provider="kulo_hindsight.bridge:KuloBridgeLLM",
            api_key="",
            base_url="",
            model="gemini-3.8-flash",
        )
        assert isinstance(llm._provider_impl, KuloBridgeLLM)

        await llm.verify_connection()
        structured = await llm.call(
            messages=[{"role": "user", "content": "Extract facts"}],
            response_format=SampleFacts,
            scope="retain",
        )
        assert isinstance(structured.content, SampleFacts)
        assert structured.content.facts == ["uses vertex"]
        assert structured.usage.input_tokens == 11
        assert structured.usage.output_tokens == 7

        tool_turn = await llm.call_with_tools(
            messages=[{"role": "user", "content": "Search memory"}],
            tools=[{
                "type": "function",
                "function": {
                    "name": "lookup",
                    "description": "Search",
                    "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
                },
            }],
            tool_choice=LLMToolChoice.named("lookup"),
        )
        assert len(tool_turn.tool_calls) == 1
        assert tool_turn.tool_calls[0].name == "lookup"
        assert tool_turn.tool_calls[0].arguments == {"query": "vertex"}
        assert received[0]["providerId"] == "api-vertex"
        assert received[0]["modelId"] == "gemini-3.8-flash"

        # Rotating bridge token on disk recovers automatically on 401 without restarting Hindsight.
        expected_token = "bridge-token-v2"
        _write_bridge(bridge_file, url, expected_token)
        plain = await llm.call(messages=[{"role": "user", "content": "ping"}])
        assert plain.content == "OK"
        await llm.cleanup()
    finally:
        server.shutdown()


@pytest.mark.asyncio
async def test_kulo_bridge_llm_maps_structured_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    mode = {"case": "length"}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def do_POST(self):
            case = mode["case"]
            if case == "length":
                status, body = 200, {"text": "partial", "stopReason": "length", "usage": {}}
            elif case == "auth":
                status, body = 403, {"error": {"code": "auth", "message": "Invalid upstream key", "retryable": False}}
            else:
                status, body = 400, {"error": {"code": "content_policy", "message": "Blocked", "retryable": False}}
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server, url = _start_server(Handler)
    try:
        bridge_file = tmp_path / "memory-llm-bridge.json"
        _write_bridge(bridge_file, url, "token-error-test")
        monkeypatch.setenv("KULO_HINDSIGHT_MODEL_PROVIDER_ID", "api-vertex")
        monkeypatch.setenv("KULO_HINDSIGHT_BRIDGE_FILE", str(bridge_file))

        provider = KuloBridgeLLM("kulo_hindsight.bridge:KuloBridgeLLM", "", "", "gemini-3.8-flash")
        with pytest.raises(OutputTooLongError):
            await provider.call(messages=[{"role": "user", "content": "hi"}], max_retries=0)
        mode["case"] = "auth"
        with pytest.raises(ProviderAuthError):
            await provider.call(messages=[{"role": "user", "content": "hi"}], max_retries=0)
        mode["case"] = "policy"
        with pytest.raises(ProviderContentPolicyError):
            await provider.call(messages=[{"role": "user", "content": "hi"}], max_retries=0)
        await provider.cleanup()
    finally:
        server.shutdown()
