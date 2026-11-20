"""Loopback LLM bridge provider delegating Hindsight model calls to Kulo Hub."""

from __future__ import annotations

import asyncio
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
import json
import logging
import os
from pathlib import Path
import stat
import time
from typing import Any, Callable
from urllib.parse import urlparse

import httpx
from pydantic import ValidationError

from hindsight_api.engine.llm_interface import (
    LLMInterface,
    OutputTooLongError,
    ProviderAuthError,
    ProviderContentPolicyError,
    ProviderRateLimitResetError,
)
from hindsight_api.engine.llm_trace import LLMResponseUsage, stash_response_usage
from hindsight_api.engine.llm_wrapper import parse_llm_json
from hindsight_api.engine.providers.openai_compatible_llm import _strip_code_fences, _strip_reasoning_tags
from hindsight_api.engine.response_models import LLMCallResult, TokenUsage
from hindsight_api.engine.structured_output import provider_json_schema, strict_json_schema
from hindsight_api.metrics import get_metrics_collector
from hindsight_api.worker.stage import set_stage

logger = logging.getLogger(__name__)

BRIDGE_OWNER = "kulo-memory-llm-bridge-v1"
DEFAULT_BRIDGE_TIMEOUT = 180.0
_LOOPBACK_HOSTS = {"127.0.0.1", "::1"}


def load_bridge_config(file: Path) -> tuple[str, str, int]:
    """Load and verify the private loopback bridge descriptor written by Kulo Hub."""
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError("Kulo memory bridge file must be a private regular file")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise ValueError("Kulo memory bridge file belongs to another user")
    raw = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("owner") != BRIDGE_OWNER:
        raise ValueError("Invalid Kulo memory bridge descriptor")
    url = raw.get("url")
    token = raw.get("token")
    if not isinstance(url, str) or not isinstance(token, str) or not token.strip() or any(ord(ch) < 32 for ch in token):
        raise ValueError("Invalid Kulo memory bridge credentials")
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.hostname not in _LOOPBACK_HOSTS or not parsed.port or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Kulo memory bridge URL must be a plain loopback HTTP endpoint")
    return url, token.strip(), info.st_mtime_ns


def _normalize_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for message in messages:
        role = str(message.get("role", "user"))
        content = message.get("content", "")
        if isinstance(content, str):
            normalized.append({"role": role, "content": content})
        elif isinstance(content, list):
            parts: list[dict[str, Any]] = []
            for part in content:
                if isinstance(part, dict):
                    parts.append(part)
                else:
                    parts.append({"type": "text", "text": str(part)})
            normalized.append({"role": role, "content": parts})
        else:
            normalized.append({"role": role, "content": str(content)})
    return normalized


def _extract_error(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
        if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
            return payload["error"]
    except Exception:
        pass
    return {"code": "upstream_error", "message": f"Kulo Hub LLM bridge returned HTTP {response.status_code}", "retryable": response.status_code >= 500}


class KuloBridgeLLM(LLMInterface):
    """LLMInterface backed by Kulo Hub's loopback model bridge."""

    def __init__(
        self,
        provider: str,
        api_key: str,
        base_url: str,
        model: str,
        reasoning_effort: str | None = None,
        timeout: float | None = None,
        **kwargs: Any,
    ):
        super().__init__(provider, api_key, base_url, model, reasoning_effort, timeout=timeout or DEFAULT_BRIDGE_TIMEOUT, **kwargs)
        self._provider_id = os.environ.get("KULO_HINDSIGHT_MODEL_PROVIDER_ID", "").strip()
        bridge_file = os.environ.get("KULO_HINDSIGHT_BRIDGE_FILE", "").strip()
        if not self._provider_id:
            raise ValueError("KULO_HINDSIGHT_MODEL_PROVIDER_ID is required for KuloBridgeLLM")
        if not bridge_file:
            raise ValueError("KULO_HINDSIGHT_BRIDGE_FILE is required for KuloBridgeLLM")
        self._bridge_file = Path(bridge_file)
        self._cached_bridge: tuple[str, str, int] | None = None
        self._client: httpx.AsyncClient | None = None

    def supports_attempt_scoped_concurrency(self) -> bool:
        return True

    def supports_vision(self) -> bool | None:
        return None

    def _http_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            # Never inherit HTTP_PROXY/ALL_PROXY for loopback bridge calls.
            self._client = httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=self.timeout)
        return self._client

    def _bridge(self, *, force_reload: bool = False) -> tuple[str, str]:
        if not force_reload and self._cached_bridge is not None:
            url, token, mtime_ns = self._cached_bridge
            try:
                if self._bridge_file.lstat().st_mtime_ns == mtime_ns:
                    return url, token
            except OSError:
                self._cached_bridge = None
        loaded = load_bridge_config(self._bridge_file)
        self._cached_bridge = loaded
        return loaded[0], loaded[1]

    async def verify_connection(self) -> None:
        result = await self.call(
            messages=[{"role": "user", "content": "Reply with OK."}],
            max_completion_tokens=16,
            scope="verify",
            max_retries=1,
        )
        if not isinstance(result.content, str) or not result.content.strip():
            raise RuntimeError("Kulo Hub model bridge returned an empty verification response")

    async def call(
        self,
        messages: list[dict[str, str]],
        response_format: Any | None = None,
        max_completion_tokens: int | None = None,
        temperature: float | None = None,
        scope: str = "memory",
        max_retries: int = 10,
        initial_backoff: float = 1.0,
        max_backoff: float = 60.0,
        skip_validation: bool = False,
        strict_schema: bool = False,
        cached_prefix: str | None = None,
        attempt_context: Callable[[], Any] | None = None,
    ) -> LLMCallResult:
        del cached_prefix  # Prompt caching is managed upstream by the provider adapter.
        start_time = time.perf_counter()
        schema_payload: dict[str, Any] | None = None
        if response_format is not None and hasattr(response_format, "model_json_schema"):
            schema = strict_json_schema(response_format) if strict_schema else provider_json_schema(response_format)
            schema_payload = {
                "name": getattr(response_format, "__name__", "response"),
                "schema": schema,
                "strict": bool(strict_schema),
            }

        request_body: dict[str, Any] = {
            "providerId": self._provider_id,
            "modelId": self.model,
            "messages": _normalize_messages(messages),
            "scope": scope,
        }
        if schema_payload is not None:
            request_body["responseSchema"] = schema_payload
        if max_completion_tokens is not None:
            request_body["maxCompletionTokens"] = int(max_completion_tokens)
        if temperature is not None:
            request_body["temperature"] = float(temperature)

        force_reload = False
        token_refreshes = 0

        for attempt in range(max_retries + 1):
            try:
                url, token = self._bridge(force_reload=force_reload)
                force_reload = False
            except (FileNotFoundError, OSError, json.JSONDecodeError, ValueError) as exc:
                self._cached_bridge = None
                if attempt < max_retries:
                    await asyncio.sleep(min(initial_backoff * (2**attempt), max_backoff))
                    force_reload = True
                    continue
                raise RuntimeError(f"Kulo Hub model bridge is unavailable: {exc}") from exc

            try:
                async with attempt_context() if attempt_context is not None else nullcontext():
                    set_stage(f"llm.kulo.{scope}.attempt={attempt + 1}/{max_retries + 1}")
                    response = await asyncio.wait_for(
                        self._http_client().post(
                            url,
                            json=request_body,
                            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                        ),
                        timeout=self.timeout,
                    )
            except (httpx.ConnectError, httpx.ReadTimeout, httpx.WriteTimeout, httpx.ConnectTimeout, httpx.RemoteProtocolError, asyncio.TimeoutError) as exc:
                self._cached_bridge = None
                force_reload = True
                if attempt < max_retries:
                    await asyncio.sleep(min(initial_backoff * (2**attempt), max_backoff))
                    continue
                raise RuntimeError(f"Kulo Hub model bridge request failed: {exc}") from exc

            if response.status_code == 401:
                err = _extract_error(response)
                if err.get("code") == "bridge_unauthorized" and token_refreshes < 2:
                    token_refreshes += 1
                    previous = (url, token)
                    self._cached_bridge = None
                    try:
                        refreshed = self._bridge(force_reload=True)
                    except Exception:
                        refreshed = previous
                    if refreshed != previous:
                        continue
                raise ProviderAuthError(str(err.get("message") or "Model authentication failed"))

            if response.status_code >= 400:
                err = _extract_error(response)
                code = str(err.get("code") or "upstream_error")
                message = str(err.get("message") or f"Kulo Hub LLM bridge error (HTTP {response.status_code})")
                retryable = bool(err.get("retryable", response.status_code in (408, 429, 500, 502, 503, 504)))
                retry_after = err.get("retryAfterSeconds")
                if code == "auth":
                    raise ProviderAuthError(message)
                if code == "content_policy":
                    raise ProviderContentPolicyError(message)
                if code == "output_too_long":
                    raise OutputTooLongError(message)
                if code == "rate_limit" and isinstance(retry_after, (int, float)) and retry_after > max_backoff:
                    raise ProviderRateLimitResetError(
                        datetime.now(timezone.utc) + timedelta(seconds=float(retry_after)),
                        message,
                    )
                if retryable and attempt < max_retries:
                    delay = float(retry_after) if isinstance(retry_after, (int, float)) and retry_after > 0 else min(initial_backoff * (2**attempt), max_backoff)
                    await asyncio.sleep(min(delay, max_backoff))
                    if response.status_code in (502, 503, 504):
                        force_reload = True
                    continue
                raise RuntimeError(message)

            payload = response.json()
            if not isinstance(payload, dict):
                raise RuntimeError("Kulo Hub model bridge returned an invalid JSON payload")

            usage_raw = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
            input_tokens = int(usage_raw.get("inputTokens") or 0)
            output_tokens = int(usage_raw.get("outputTokens") or 0)
            cached_tokens = int(usage_raw.get("cachedTokens") or 0)
            thoughts_tokens = int(usage_raw.get("thoughtsTokens") or 0)
            total_tokens = int(usage_raw.get("totalTokens") or (input_tokens + output_tokens))
            stash_response_usage(
                LLMResponseUsage(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cached_tokens=cached_tokens,
                    thoughts_tokens=thoughts_tokens,
                )
            )

            stop_reason = str(payload.get("stopReason") or "stop")
            if stop_reason == "length":
                raise OutputTooLongError(f"LLM output exceeded token limit for {self._provider_id}/{self.model}")
            if stop_reason in ("content_filter", "refusal"):
                raise ProviderContentPolicyError(f"Model refused request ({stop_reason})")

            text = payload.get("text")
            content = _strip_reasoning_tags(text if isinstance(text, str) else "")

            if response_format is not None:
                clean = _strip_code_fences(content)
                try:
                    json_data = json.loads(clean)
                except json.JSONDecodeError:
                    try:
                        json_data = json.loads(content)
                    except json.JSONDecodeError:
                        if attempt < max_retries:
                            await asyncio.sleep(min(initial_backoff * (2**attempt), max_backoff))
                            continue
                        json_data = parse_llm_json(content)

                if skip_validation:
                    parsed: Any = json_data
                else:
                    try:
                        parsed = response_format.model_validate(json_data)
                    except ValidationError:
                        if attempt < max_retries:
                            await asyncio.sleep(min(initial_backoff * (2**attempt), max_backoff))
                            continue
                        raise
            else:
                parsed = content

            duration = time.perf_counter() - start_time
            get_metrics_collector().record_llm_call(
                provider=f"kulo:{self._provider_id}",
                model=self.model,
                scope=scope,
                duration=duration,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                success=True,
                cached_input_tokens=cached_tokens,
                thoughts_tokens=thoughts_tokens,
            )
            try:
                from hindsight_api.tracing import _serialize_for_span, get_span_recorder

                get_span_recorder().record_llm_call(
                    provider=f"kulo:{self._provider_id}",
                    model=self.model,
                    scope=scope,
                    messages=messages,
                    response_content=_serialize_for_span(parsed),
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cached_tokens=cached_tokens,
                    thoughts_tokens=thoughts_tokens,
                    duration=duration,
                )
            except Exception:
                pass

            return LLMCallResult(
                content=parsed,
                usage=TokenUsage(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    total_tokens=total_tokens,
                    cached_tokens=cached_tokens,
                    thoughts_tokens=thoughts_tokens,
                ),
            )

        raise RuntimeError("Kulo Hub model bridge exhausted retries")

    async def cleanup(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None
