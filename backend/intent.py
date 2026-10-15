"""
自然语言意图解析 (规则版, 不依赖外部 LLM)。

把用户的中文/英文描述 -> 结构化的电台检索参数 (风格标签 / 国家 / 语言 / 场景)。
这是"简单版个性化"的核心: 用关键词规则把模糊需求翻译成可检索的维度。
后续可无缝替换为 LLM 意图识别 (输入输出契约不变)。
"""
from __future__ import annotations

from typing import Any

# 风格关键词 -> Radio Browser 的 tag (标签实际值, 英文)
STYLE_KEYWORDS: dict[str, list[str]] = {
    "jazz": ["爵士", "jazz", "bossa"],
    "rock": ["摇滚", "rock", "classic rock"],
    "classical": ["古典", "classical", "orchestra", "piano"],
    "electronic": ["电子", "电音", "electronic", "edm", "house", "techno", "trance", "synth"],
    "pop": ["流行", "pop"],
    "hip hop": ["嘻哈", "说唱", "hip hop", "hip-hop", "hiphop", "rap", "rnb", "r&b"],
    "folk": ["民谣", "folk", "acoustic"],
    "country": ["乡村", "country"],
    "latin": ["拉丁", "latin", "salsa", "samba", "桑巴", "tango", "reggaeton"],
    "reggae": ["雷鬼", "reggae", "dub"],
    "metal": ["金属", "metal", "heavy metal"],
    "blues": ["布鲁斯", "蓝调", "blues"],
    "chillout": ["放松", "舒缓", "休闲", "chill", "chillout", "lounge", "ambient", "氛围", "轻音乐", "relax"],
    "world": ["世界音乐", "world music", "world"],
    "news": ["新闻", "news", "talk", "资讯"],
    "soul": ["灵魂", "soul", "funk", "放克"],
    "indie": ["独立", "indie", "alternative", "另类"],
    "gospel": ["福音", "gospel", "christian"],
    "oldies": ["老歌", "金曲", "经典", "oldies", "gold", "怀旧", "retro"],
}

# 场景关键词 -> 推荐的风格标签 (多标签命中)
MOOD_KEYWORDS: dict[str, list[str]] = {
    "work": ["工作", "办公", "专注", "学习", "看书", "study", "work", "focus", "coding", "写代码"],
    "sleep": ["睡觉", "助眠", "睡眠", "睡前", "sleep", "asmr", "冥想", "meditation"],
    "sport": ["运动", "健身", "跑步", "锻炼", "workout", "gym", "run", "跑步"],
    "night": ["深夜", "夜晚", "午夜", "晚上", "凌晨", "night", "late"],
    "party": ["派对", "聚会", "派对", "party", "club", "蹦迪", "跳舞", "dance"],
    "morning": ["早晨", "清晨", "早上", "morning", "早餐", "起床"],
    "drive": ["开车", "驾驶", "通勤", "路上", "drive", "driving", "commute"],
    "rain": ["下雨", "雨天", "rain", "雨天", "咖啡馆", "咖啡", "cafe", "coffee"],
}

# 地区关键词 -> ISO 国家码
COUNTRY_KEYWORDS: dict[str, list[str]] = {
    "US": ["美国", "美", "usa", "america", "united states"],
    "GB": ["英国", "英", "uk", "britain", "british", "london", "伦敦"],
    "CN": ["中国", "中", "china", "chinese", "北京", "上海"],
    "JP": ["日本", "日", "japan", "japanese", "东京", "tokyo"],
    "KR": ["韩国", "韩", "korea", "korean", "首尔", "seoul"],
    "FR": ["法国", "法", "france", "french", "巴黎", "paris"],
    "DE": ["德国", "德", "germany", "german", "柏林", "berlin"],
    "IT": ["意大利", "italy", "italian", "罗马", "rome"],
    "ES": ["西班牙", "spain", "spanish", "马德里", "madrid"],
    "PT": ["葡萄牙", "portugal", "portuguese", "里斯本"],
    "BR": ["巴西", "brazil", "brazilian", "sao paulo", "圣保罗"],
    "MX": ["墨西哥", "mexico", "mexican"],
    "AR": ["阿根廷", "argentina"],
    "CU": ["古巴", "cuba"],
    "IN": ["印度", "india", "indian"],
    "AU": ["澳大利亚", "澳洲", "australia", "悉尼", "sydney"],
    "CA": ["加拿大", "canada", "canadian"],
    "RU": ["俄罗斯", "russia", "russian"],
    "NL": ["荷兰", "netherlands", "dutch", "阿姆斯特丹"],
    "SE": ["瑞典", "sweden", "swedish"],
    "NO": ["挪威", "norway"],
    "CH": ["瑞士", "switzerland", "swiss"],
    "AT": ["奥地利", "austria", "vienna", "维也纳"],
    "GR": ["希腊", "greece", "greek"],
    "TR": ["土耳其", "turkey", "turkish"],
    "TH": ["泰国", "thailand", "thai"],
    "ID": ["印尼", "印度尼西亚", "indonesia"],
    "IE": ["爱尔兰", "ireland", "irish"],
    "JM": ["牙买加", "jamaica"],
    "ZA": ["南非", "south africa"],
}

# 语言关键词 -> Radio Browser 语言字段值
LANGUAGE_KEYWORDS: dict[str, list[str]] = {
    "chinese": ["中文", "汉语", "国语", "chinese", "mandarin", "cantonese", "粤语"],
    "english": ["英文", "英语", "english"],
    "japanese": ["日语", "日文", "japanese"],
    "korean": ["韩语", "韩文", "korean"],
    "french": ["法语", "法文", "french"],
    "german": ["德语", "德文", "german"],
    "spanish": ["西班牙语", "西语", "spanish"],
    "portuguese": ["葡萄牙语", "葡语", "portuguese"],
    "italian": ["意大利语", "italian"],
    "russian": ["俄语", "russian"],
    "arabic": ["阿拉伯语", "arabic"],
    "hindi": ["印地语", "hindi"],
}


def _hit(text: str, keywords: list[str]) -> bool:
    low = text.lower()
    return any(kw.lower() in low for kw in keywords)


def parse_intent(text: str) -> dict[str, Any]:
    """把自然语言解析为电台检索参数。

    返回:
      { "tags": [...], "country": "US", "language": "english", "mood": "night", "raw": "..." }
    """
    result: dict[str, Any] = {"tags": [], "raw": text.strip()}
    if not text.strip():
        return result

    # 1) 风格
    for tag, kws in STYLE_KEYWORDS.items():
        if _hit(text, kws):
            result["tags"].append(tag)

    # 2) 场景 -> 追加风格标签
    for mood, kws in MOOD_KEYWORDS.items():
        if _hit(text, kws):
            result["mood"] = mood
            for tag in _MOOD_TAGS.get(mood, []):
                if tag not in result["tags"]:
                    result["tags"].append(tag)

    # 3) 国家
    for cc, kws in COUNTRY_KEYWORDS.items():
        if _hit(text, kws):
            result["country"] = cc
            break

    # 4) 语言
    for lang, kws in LANGUAGE_KEYWORDS.items():
        if _hit(text, kws):
            result["language"] = lang
            break

    # 5) 名称直接搜索 (引号内或明显专有名词)
    if '"' in text:
        quoted = text.split('"')[1::2]
        if quoted:
            result["name"] = quoted[0]

    return result


# 场景 -> 风格标签映射
_MOOD_TAGS: dict[str, list[str]] = {
    "work": ["ambient", "classical", "chillout"],
    "sleep": ["ambient", "chillout", "relax"],
    "sport": ["electronic", "dance", "house"],
    "night": ["jazz", "chillout", "lounge"],
    "party": ["dance", "electronic", "house"],
    "morning": ["pop", "acoustic", "light"],
    "drive": ["rock", "pop", "electronic"],
    "rain": ["jazz", "chillout", "lofi"],
}
