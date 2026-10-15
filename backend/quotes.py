"""
句子推送库: 由 LLM (DeepSeek) 按时段生成诗/句子, 每句映射到一种音乐风格 (Radio Browser tags)。

机制:
- 每天每个时段首次请求时调用 LLM 生成, 结果缓存到内存 (key = "YYYY-MM-DD_时段")。
- 同一天同一时段复用缓存; 跨天自动重新生成。
- LLM 不可用 / 失败时降级到本地预设库 QUOTES, 保证离线可用。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

import llm
from agent_llm import VALID_TAGS

# 本地预设兜底 (LLM 不可用时使用)
QUOTES: dict[str, list[dict[str, Any]]] = {
    # 清晨 5:00 - 9:00
    "morning": [
        {"text": "清晨的光落在窗台，世界还没有完全醒来", "tags": ["ambient", "chillout"], "mood": "清晨 · 清醒"},
        {"text": "一日之计在于晨，像露珠一样清爽地开始", "tags": ["classical", "acoustic"], "mood": "清晨 · 清爽"},
        {"text": "鸟鸣是天空的闹钟，微凉的风穿过发梢", "tags": ["folk", "acoustic"], "mood": "清晨 · 自然"},
        {"text": "咖啡香里，慢一点，把今天过成一首诗", "tags": ["jazz", "lounge"], "mood": "清晨 · 慵懒"},
        {"text": "太阳升起，万物都有新一次的温柔", "tags": ["pop", "acoustic"], "mood": "清晨 · 温暖"},
    ],
    # 上午 9:00 - 12:00
    "day": [
        {"text": "专注是此刻最好的旋律，让思绪安静成一条河", "tags": ["ambient", "classical"], "mood": "上午 · 专注"},
        {"text": "把杂念推开，只留下手头正在做的事", "tags": ["chillout", "classical"], "mood": "上午 · 心流"},
        {"text": "键盘声像小雨，敲出属于你的节奏", "tags": ["lofi", "ambient"], "mood": "上午 · 轻快"},
        {"text": "努力的人，配得上一首轻快的歌", "tags": ["pop", "electronic"], "mood": "上午 · 元气"},
        {"text": "窗外车水马龙，心里自成一方天地", "tags": ["chillout", "lounge"], "mood": "上午 · 沉静"},
    ],
    # 午后 12:00 - 18:00
    "noon": [
        {"text": "午后的阳光慵懒，像一只伸懒腰的猫", "tags": ["bossa nova", "jazz"], "mood": "午后 · 慵懒"},
        {"text": "茶凉了半杯，时光慢了下来", "tags": ["jazz", "chillout"], "mood": "午后 · 闲适"},
        {"text": "风把云吹散，也把倦意吹远", "tags": ["acoustic", "pop"], "mood": "午后 · 清爽"},
        {"text": "小睡片刻，醒来世界依旧明亮", "tags": ["lofi", "ambient"], "mood": "午后 · 治愈"},
        {"text": "给忙碌一个逗号，再继续赶路", "tags": ["chillout", "electronic"], "mood": "午后 · 放松"},
    ],
    # 傍晚 18:00 - 22:00
    "evening": [
        {"text": "落日熔金，暮云合璧", "tags": ["classical", "ambient"], "mood": "傍晚 · 温柔"},
        {"text": "晚霞是天空写给你的一封情书", "tags": ["pop", "romantic"], "mood": "傍晚 · 浪漫"},
        {"text": "回家的路，被夕阳铺成金色", "tags": ["folk", "acoustic"], "mood": "傍晚 · 归途"},
        {"text": "华灯初上，城市的夜开始呼吸", "tags": ["electronic", "chillout"], "mood": "傍晚 · 都市"},
        {"text": "一杯小酒，配一首老歌刚刚好", "tags": ["blues", "jazz"], "mood": "傍晚 · 微醺"},
    ],
    # 深夜 22:00 - 5:00
    "night": [
        {"text": "夜深了，把白天的喧嚣轻轻放下", "tags": ["ambient", "chillout"], "mood": "深夜 · 静谧"},
        {"text": "月亮是个安静的倾听者", "tags": ["classical", "ambient"], "mood": "深夜 · 空灵"},
        {"text": "一个人也要好好拥抱这个夜晚", "tags": ["lofi", "jazz"], "mood": "深夜 · 独处"},
        {"text": "思绪像星光，散落在无人的街", "tags": ["lofi", "chillout"], "mood": "深夜 · 放空"},
        {"text": "失眠也没关系，让音乐替你数星星", "tags": ["ambient", "lofi"], "mood": "深夜 · 助眠"},
    ],
}

# 时段标签 (用于前端展示)
PERIOD_LABELS: dict[str, str] = {
    "morning": "清晨",
    "day": "上午",
    "noon": "午后",
    "evening": "傍晚",
    "night": "深夜",
}

# LLM 生成缓存: key = "YYYY-MM-DD_时段"
_cache: dict[str, list[dict[str, Any]]] = {}

_TAGS_HINT = (
    "jazz, rock, classical, electronic, pop, hip hop, folk, country, latin, reggae, "
    "metal, blues, chillout, ambient, house, dance, lofi, acoustic, news, soul, funk, "
    "indie, alternative, gospel, oldies, bossa nova, lounge, relax, world, techno, "
    "trance, edm, rnb, dub, romantic"
)

_SYSTEM = (
    "你是电台推荐助手，负责为一个特定时段创作 5 句简短优美的文案（诗句/心情句子），每句都能唤起一种音乐风格。\n\n"
    "要求：\n"
    "1. 每句 8-25 个字，中文，有画面感和情绪，符合该时段氛围\n"
    "2. 每句对应 1-2 个音乐风格标签，只能从下列英文标签中选择：\n"
    + _TAGS_HINT + "\n"
    "3. mood 是该句的心情/场景标签，格式如「深夜 · 静谧」\n"
    "4. 5 句的音乐风格尽量不重复\n\n"
    '只输出 JSON，不要输出其他文字。格式：\n'
    '{"quotes": [{"text": "...", "tags": ["..."], "mood": "..."}]}'
)


def period_of(hour: int) -> str:
    """根据小时返回时段 key。"""
    if 5 <= hour < 9:
        return "morning"
    if 9 <= hour < 12:
        return "day"
    if 12 <= hour < 18:
        return "noon"
    if 18 <= hour < 22:
        return "evening"
    return "night"


def _clean_quotes(items: Optional[list]) -> list[dict[str, Any]]:
    """过滤 LLM 输出, 只保留文本非空且标签在白名单内的句子。"""
    out: list[dict[str, Any]] = []
    for q in items or []:
        text = (q.get("text") or "").strip() if isinstance(q, dict) else ""
        if not text:
            continue
        tags: list[str] = []
        for t in (q.get("tags") or []):
            t = (t or "").strip().lower()
            if t in VALID_TAGS and t not in tags:
                tags.append(t)
        if not tags:
            continue
        mood = (q.get("mood") or "").strip()
        out.append({"text": text, "tags": tags[:2], "mood": mood or ""})
        if len(out) >= 5:
            break
    return out


def _try_generate(label: str) -> Optional[list[dict[str, Any]]]:
    """调用 LLM 生成当前时段句子, 失败返回 None。"""
    if not llm.available():
        return None
    try:
        data = llm.chat_json(
            [
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": f"当前时段：{label}。请创作 5 句文案。"},
            ],
            temperature=0.9,
            max_tokens=600,
        )
        cleaned = _clean_quotes(data.get("quotes"))
        return cleaned if len(cleaned) >= 3 else None
    except Exception:  # noqa: BLE001 - 失败交给本地兜底
        return None


def get_quotes(hour: int) -> dict[str, Any]:
    """返回当前时段的句子列表 (LLM 生成优先, 本地预设兜底)。"""
    period = period_of(hour)
    label = PERIOD_LABELS[period]
    today = datetime.now().strftime("%Y-%m-%d")
    key = f"{today}_{period}"

    if key not in _cache:
        generated = _try_generate(label)
        if generated:
            _cache[key] = generated

    quotes = _cache.get(key) or QUOTES[period]
    return {
        "period": period,
        "label": label,
        "quotes": quotes,
        "source": "llm" if key in _cache else "preset",
    }
