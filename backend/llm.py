"""
LLM 客户端 (OpenAI 兼容接口, 轻量封装, 不依赖第三方 SDK)。

支持两层 key 来源 (BYOK):
1. 服务端默认: backend/.env 中的 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL (可选, 留空则服务端无默认 key)
2. 请求级配置: 调用 chat()/chat_json() 时传入 cfg = {api_key, base_url, model}
   —— 由前端用户在设置面板填写, 每次请求携带, 优先于服务端默认。

这样上线后每位访客可用自己的 key (烧自己的额度), 服务端无需暴露共享 key。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Optional

import requests

ENV_PATH = Path(__file__).resolve().parent / ".env"
DEFAULT_MODEL = "deepseek-chat"
DEFAULT_BASE_URL = "https://api.deepseek.com"
_TIMEOUT = 30

_config: dict[str, str] = {}


def load_env(path: Optional[Path] = None) -> None:
    """从 .env 文件加载环境变量 (轻量解析, 不依赖 python-dotenv)。"""
    global _config
    p = path or ENV_PATH
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k, v)
        _config[k] = v


def api_key() -> str:
    return os.environ.get("DEEPSEEK_API_KEY", _config.get("DEEPSEEK_API_KEY", ""))


def base_url() -> str:
    return os.environ.get("DEEPSEEK_BASE_URL", _config.get("DEEPSEEK_BASE_URL", DEFAULT_BASE_URL))


def available() -> bool:
    """服务端是否已配置默认 key。"""
    return bool(api_key())


def _resolve(cfg: Optional[dict] = None) -> tuple[str, str, str]:
    """解析出 (api_key, base_url, model)。

    - cfg=None: 使用服务端默认配置 (句子库等内部公共调用)。
    - cfg 为 dict (含空 dict): 纯 BYOK, 只用访客配置; 未填 base_url/model 用官方默认值, 不回落服务端 key。
    """
    if cfg is None:
        return api_key(), base_url(), DEFAULT_MODEL
    key = (cfg.get("api_key") or "").strip()
    base = (cfg.get("base_url") or "").strip() or DEFAULT_BASE_URL
    model = (cfg.get("model") or "").strip() or DEFAULT_MODEL
    return key, base, model


def has_key(cfg: Optional[dict] = None) -> bool:
    """当前 (或 cfg 指定) 是否有可用 key。"""
    key, _, _ = _resolve(cfg)
    return bool(key)


def status() -> dict[str, Any]:
    """返回服务端 LLM 配置状态 (不含 key 明文, 供前端展示)。"""
    return {
        "server_key": bool(api_key()),
        "model": DEFAULT_MODEL,
        "base_url": base_url(),
    }


def chat(
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.7,
    max_tokens: int = 800,
    json_mode: bool = False,
    cfg: Optional[dict] = None,
) -> str:
    """调用 chat/completions, 返回文本内容。cfg 为请求级 {api_key, base_url, model}。"""
    key, base, model = _resolve(cfg)
    if not key:
        raise RuntimeError("LLM api_key 未配置")
    url = base.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    resp = requests.post(url, headers=headers, json=payload, timeout=_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def chat_json(
    messages: list[dict[str, str]],
    *,
    temperature: float = 0.4,
    max_tokens: int = 800,
    cfg: Optional[dict] = None,
) -> dict[str, Any]:
    """调用 LLM 并解析为 JSON 字典 (带代码块剥离容错)。"""
    text = chat(messages, temperature=temperature, max_tokens=max_tokens, json_mode=True, cfg=cfg)
    # 剥离可能的 ```json ... ``` 包裹
    m = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    # 截取首个 { ... } 平衡块
    start = text.find("{")
    if start >= 0:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    text = text[start : i + 1]
                    break
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}
