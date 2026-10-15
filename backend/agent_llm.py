"""
LLM 驱动的意图解析与个性化推荐 (DeepSeek)。

职责:
1. parse_intent(): 用 LLM 把自然语言解析为结构化检索参数 (输出契约与规则版 intent.py 一致)
2. personalize(): 结合定位 + 天气 + 时间, 用 LLM 生成个性化推荐意图与解释文案

LLM 失败时均有规则兜底, 保证主流程可用。
"""
from __future__ import annotations

import re
from typing import Any, Optional

import llm

# Radio Browser 常见有效风格标签 (LLM 输出只保留白名单内的标签)
VALID_TAGS: set[str] = {
    "jazz", "rock", "classical", "electronic", "pop", "hip hop", "folk",
    "country", "latin", "reggae", "metal", "blues", "chillout", "ambient",
    "house", "dance", "lofi", "acoustic", "news", "talk", "soul", "funk",
    "indie", "alternative", "gospel", "oldies", "bossa nova", "lounge",
    "relax", "world", "techno", "trance", "edm", "rnb", "dub", "romantic",
}

_INTENT_SYSTEM = """你是音乐电台推荐助手。把用户的自然语言需求解析成结构化检索参数。

可用的风格标签（只能从下列英文标签中选择，1-4 个）：
jazz, rock, classical, electronic, pop, hip hop, folk, country, latin, reggae,
metal, blues, chillout, ambient, house, dance, lofi, acoustic, news, soul, funk,
indie, alternative, gospel, oldies, bossa nova, lounge, relax, world, techno,
trance, edm, rnb, dub, romantic

国家用 ISO 3166-1 两位大写码（如 US、GB、CN、JP、KR、FR、DE）；语言用英文小写（如 chinese、english、japanese、korean、french、german、spanish）。

只输出 JSON，不要输出其他文字。格式：
{"tags": ["jazz"], "country": "US", "language": "english", "name": "", "mood": "night"}
没有把握的字段填空字符串或空数组。"""

_PERSONALIZE_SYSTEM = """你是音乐电台推荐助手，根据用户当前的位置、天气和时间，推荐合适的音乐风格。

可用的风格标签（只能从下列英文标签中选择 1-4 个）：
jazz, rock, classical, electronic, pop, hip hop, folk, country, latin, reggae,
metal, blues, chillout, ambient, house, dance, lofi, acoustic, news, soul, funk,
indie, alternative, gospel, oldies, bossa nova, lounge, relax, world, techno,
trance, edm, rnb, dub, romantic

只输出 JSON，不要输出其他文字。格式：
{"tags": ["chillout", "jazz"], "country": "", "language": "", "explanation": "一句中文解释，说明为什么此刻推荐这些风格"}
country 和 language 一般留空（除非有强烈理由）；explanation 控制在 30 字以内，有画面感。"""


def _clean_tags(tags: list[str]) -> list[str]:
    """过滤 LLM 输出的标签, 只保留白名单内的。"""
    out: list[str] = []
    for t in tags or []:
        t = (t or "").strip().lower()
        if t in VALID_TAGS and t not in out:
            out.append(t)
    return out


def _clean_country(cc: Optional[str]) -> str:
    if cc and re.fullmatch(r"[A-Za-z]{2}", cc.strip()):
        return cc.strip().upper()
    return ""


def _clean_language(lang: Optional[str]) -> str:
    if lang and re.fullmatch(r"[a-z ]{2,20}", lang.strip().lower()):
        return lang.strip().lower()
    return ""


def parse_intent(text: str, context: Optional[dict[str, Any]] = None, llm_cfg: Optional[dict] = None) -> dict[str, Any]:
    """LLM 意图解析。context 为可选的定位/天气/时间上下文, llm_cfg 为请求级 {api_key, base_url, model}。"""
    user_msg = f"用户需求：{text}"
    if context:
        user_msg += "\n\n用户当前上下文：" + _format_context(context)
    try:
        data = llm.chat_json(
            [
                {"role": "system", "content": _INTENT_SYSTEM},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.3,
            cfg=llm_cfg,
        )
        return {
            "tags": _clean_tags(data.get("tags")),
            "country": _clean_country(data.get("country")),
            "language": _clean_language(data.get("language")),
            "name": (data.get("name") or "").strip(),
            "mood": (data.get("mood") or "").strip(),
            "raw": text.strip(),
        }
    except Exception as exc:  # noqa: BLE001 - LLM 失败交给上层规则兜底
        raise RuntimeError(f"LLM intent failed: {exc}")


def personalize(lat: float, lon: float, hour: int, weather: Optional[dict], location: Optional[dict], llm_cfg: Optional[dict] = None) -> dict[str, Any]:
    """结合上下文生成个性化推荐。返回 { tags, country, language, explanation }。
    llm_cfg 为访客自带的 key 配置; 为 None 时直接规则兜底, 不调用 LLM。"""
    ctx_desc = _build_context_desc(hour, weather, location)
    if llm_cfg:
        try:
            data = llm.chat_json(
                [
                    {"role": "system", "content": _PERSONALIZE_SYSTEM},
                    {"role": "user", "content": ctx_desc},
                ],
                temperature=0.7,
                cfg=llm_cfg,
            )
            result = {
                "tags": _clean_tags(data.get("tags")),
                "country": _clean_country(data.get("country")),
                "language": _clean_language(data.get("language")),
                "explanation": (data.get("explanation") or "").strip(),
            }
            if result["tags"]:
                return result
        except Exception:  # noqa: BLE001 - 降级到规则兜底
            pass
    return _fallback_personalize(hour, weather)


def _format_context(context: dict[str, Any]) -> str:
    parts: list[str] = []
    loc = context.get("location") or {}
    if loc.get("city") or loc.get("country"):
        parts.append(f"位置：{loc.get('city', '')} {loc.get('country', '')}".strip())
    w = context.get("weather") or {}
    if w.get("description"):
        parts.append(f"天气：{w['description']}，约 {w.get('temperature', '?')}°C")
    if context.get("hour") is not None:
        parts.append(f"时间：{context['hour']} 点")
    return "；".join(parts)


def _build_context_desc(hour: int, weather: Optional[dict], location: Optional[dict]) -> str:
    parts: list[str] = []
    if location:
        city = location.get("city") or location.get("country") or ""
        if city:
            parts.append(f"用户位置：{city}")
    if weather:
        parts.append(f"天气：{weather.get('description', '')}，约 {weather.get('temperature', '?')}°C")
    period = "早晨" if 5 <= hour < 9 else "上午" if 9 <= hour < 12 else "午后" if 12 <= hour < 18 else "傍晚" if 18 <= hour < 22 else "深夜"
    parts.append(f"当前时段：{period}（{hour} 点）")
    return "；".join(parts) + "。请据此推荐合适的音乐风格。"


def _fallback_personalize(hour: int, weather: Optional[dict]) -> dict[str, Any]:
    """规则兜底: 按时段 + 天气映射风格。"""
    tags: list[str] = []
    if 5 <= hour < 9:
        tags = ["acoustic", "pop"]
        exp = "清晨适合用轻快清新的旋律唤醒一天。"
    elif 9 <= hour < 12:
        tags = ["ambient", "classical"]
        exp = "上午需要专注，用舒缓的纯音乐陪你把事情做好。"
    elif 12 <= hour < 18:
        tags = ["jazz", "chillout"]
        exp = "午后慵懒，来点爵士和轻音乐刚刚好。"
    elif 18 <= hour < 22:
        tags = ["pop", "electronic"]
        exp = "傍晚的放松时刻，用明快的节奏驱散一天的疲惫。"
    else:
        tags = ["ambient", "chillout"]
        exp = "夜深了，用静谧的氛围音乐伴你入眠。"

    # 天气微调
    desc = (weather or {}).get("description", "")
    if "雨" in desc and "jazz" not in tags:
        tags.insert(0, "jazz")
    elif "雪" in desc:
        tags = ["classical", "ambient"]
        exp = "下雪天，配一段温暖的古典乐，格外应景。"
    return {"tags": tags, "country": "", "language": "", "explanation": exp}
