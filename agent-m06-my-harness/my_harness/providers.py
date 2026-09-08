"""모델 제공자 어댑터 (R07).

내부 계약(`contracts.ModelTurn`)과 제공자 형식을 여기서만 번역한다. 반복(loop)은
어떤 제공자를 쓰는지 모른다. D08 을 미뤘으므로 구현체는 Ollama 하나다.
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from .contracts import ModelTurn, ProviderError, ToolCall, ToolSpec, Usage

DEFAULT_OLLAMA_HOST = "http://localhost:11434"


class OllamaProvider:
    """Ollama 네이티브 POST /api/chat.

    OpenAI 호환 경로를 쓰지 않는다 — 두 API 에 같은 필드를 보내면 같은 기능이
    동작한다고 가정하지 않기 위해서다. thinking 은 다음 요청에 그대로 돌려준다.
    """

    name = "ollama"

    def __init__(self, client: httpx.AsyncClient, model: str, *,
                 max_output_tokens: int = 2000, context_window: int = 24576,
                 temperature: float | None = 0.6, top_p: float | None = 0.95,
                 seed: int | None = 7):
        self.client = client
        self.model = model
        self.max_output_tokens = max_output_tokens
        # num_ctx 를 명시하지 않으면 Ollama 의 기본 window(4k)로 잘리고, 도구 출력이 몇 번
        # 쌓이는 순간 done_reason='length' 로 매 실행이 죽는다. 2026-09-09 실측으로 확인.
        self.context_window = context_window
        # temperature 0 은 이 모델을 생각 루프에 빠뜨렸다(2026-09-09 실측: num_predict
        # 8000 을 다 쓰고 done_reason='length'). Qwen3 권장값을 쓰고 seed 로 재현성을 잡는다.
        self.temperature = temperature
        self.top_p = top_p
        self.seed = seed

    # ---------------------------------------------------------------- 번역
    @staticmethod
    def to_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for message in messages:
            entry: dict[str, Any] = {"role": message["role"],
                                     "content": message.get("content", "") or ""}
            if message["role"] == "tool":
                entry["tool_name"] = message.get("name", "")
            for call in message.get("calls", []):
                arguments = call["arguments"]
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments or "{}")
                    except json.JSONDecodeError:
                        arguments = {"_raw": arguments}
                entry.setdefault("tool_calls", []).append(
                    {"function": {"name": call["name"], "arguments": arguments}})
            for item in message.get("opaque", []):
                if "thinking" in item:
                    entry["thinking"] = item["thinking"]
            result.append(entry)
        return result

    def to_tools(self, tools: list[ToolSpec]) -> list[dict[str, Any]]:
        return [{"type": "function",
                 "function": {"name": spec.name, "description": spec.description,
                              "parameters": spec.parameters}}
                for spec in tools]

    # ---------------------------------------------------------------- 요청
    async def complete(self, messages: list[dict[str, Any]], tools: list[ToolSpec]) -> ModelTurn:
        options: dict[str, Any] = {"num_predict": self.max_output_tokens,
                                   "num_ctx": self.context_window}
        if self.temperature is not None:
            options["temperature"] = self.temperature
        if self.top_p is not None:
            options["top_p"] = self.top_p
        if self.seed is not None:
            options["seed"] = self.seed
        body = {"model": self.model, "stream": False,
                "messages": self.to_messages(messages),
                "options": options,
                "tools": self.to_tools(tools)}
        try:
            response = await self.client.post("/api/chat", json=body)
            response.raise_for_status()
            data = response.json()
        except httpx.HTTPStatusError as exc:
            raise ProviderError(
                f"Ollama 가 HTTP {exc.response.status_code} 를 돌려줬다") from exc
        except httpx.HTTPError as exc:
            raise ProviderError(f"Ollama 연결 실패 ({type(exc).__name__})") from exc
        except json.JSONDecodeError as exc:
            raise ProviderError("Ollama 응답이 JSON 이 아니다") from exc
        return self._turn(data)

    def _turn(self, data: dict[str, Any]) -> ModelTurn:
        if not isinstance(data, dict) or "message" not in data:
            raise ProviderError("Ollama 응답에 message 가 없다")
        reason = data.get("done_reason")
        if not data.get("done") or reason not in {None, "stop"}:
            # 잘린 응답의 도구 인자는 실행하지 않는다.
            raise ProviderError(f"Ollama 응답이 완결되지 않았다 (done_reason={reason!r})")
        message = data["message"]
        calls: list[ToolCall] = []
        for index, call in enumerate(message.get("tool_calls") or []):
            function = call.get("function") or {}
            name = function.get("name")
            if not isinstance(name, str) or not name:
                raise ProviderError("도구 호출에 이름이 없다")
            # Ollama 는 호출 id 를 주지 않을 수 있다. 없을 때만 하네스가 붙인다.
            identifier = call.get("id") or function.get("id") or f"local-{index}"
            calls.append(ToolCall(str(identifier), name, function.get("arguments", {})))
        usage_fields = {"input_tokens": data.get("prompt_eval_count"),
                        "output_tokens": data.get("eval_count")}
        known = all(isinstance(value, int) for value in usage_fields.values())
        opaque = [{"thinking": message["thinking"]}] if message.get("thinking") else []
        return ModelTurn(
            text=message.get("content") or "",
            calls=calls,
            usage=Usage(usage_fields["input_tokens"] or 0, usage_fields["output_tokens"] or 0, known),
            opaque=opaque)


def context_window_for(max_context_chars: int, max_output_tokens: int) -> int:
    """하네스가 허용한 대화 길이를 모델 window 로 옮긴다.

    영문·한글이 섞인 대화에서 토큰당 3자 정도로 잡고 출력 상한을 더한다. 두 값이
    어긋나면 하네스는 아직 여유가 있다고 보는데 모델은 잘린 응답을 준다.
    """
    return max(4096, min(131_072, max_context_chars // 3 + max_output_tokens))


def build_provider(name: str, model: str, *, timeout: float, max_output_tokens: int,
                   max_context_chars: int = 60_000, temperature: float = 0.6,
                   seed: int | None = 7,
                   host: str | None = None) -> tuple[OllamaProvider, httpx.AsyncClient]:
    """제공자와 그 클라이언트를 만든다. 호출자가 클라이언트를 닫는다."""
    if name != "ollama":
        raise ProviderError(
            f"제공자 {name!r} 는 이 버전에 없다 (D08 DEFERRED — DECISIONS.md 참고)")
    if not model:
        raise ProviderError("모델 이름을 명시해야 한다")
    client = httpx.AsyncClient(base_url=host or DEFAULT_OLLAMA_HOST, timeout=timeout,
                               trust_env=False)
    provider = OllamaProvider(
        client, model, max_output_tokens=max_output_tokens,
        context_window=context_window_for(max_context_chars, max_output_tokens),
        temperature=temperature, seed=seed)
    return provider, client
