"""
定位上下文: 经纬度 -> 天气 + 城市名。

数据源 (均免费、无需 Key):
- 天气:     Open-Meteo  (https://api.open-meteo.com/v1/forecast)
- 反向地理编码: BigDataCloud (https://api.bigdatacloud.net/data/reverse-geocode-client)
"""
from __future__ import annotations

from typing import Any, Optional

import requests

_TIMEOUT = 10
_USER_AGENT = "RadioAgent/1.0 (portfolio demo)"

# WMO 天气代码 -> 中文描述
_WMO: dict[int, str] = {
    0: "晴朗",
    1: "基本晴朗", 2: "局部多云", 3: "阴天",
    45: "有雾", 48: "雾凇",
    51: "小毛毛雨", 53: "毛毛雨", 55: "浓毛毛雨",
    56: "冻毛毛雨", 57: "强冻毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨", 67: "强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪",
    77: "米雪",
    80: "小阵雨", 81: "阵雨", 82: "强阵雨",
    85: "阵雪", 86: "强阵雪",
    95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷暴伴冰雹",
}


def _wmo_desc(code: Optional[int]) -> str:
    if code is None:
        return "未知"
    return _WMO.get(int(code), "未知")


def get_weather(lat: float, lon: float) -> Optional[dict[str, Any]]:
    """获取当前天气。"""
    try:
        resp = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat,
                "longitude": lon,
                "current_weather": "true",
                "timezone": "auto",
            },
            headers={"User-Agent": _USER_AGENT},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        cw = resp.json().get("current_weather", {})
        return {
            "temperature": cw.get("temperature"),
            "windspeed": cw.get("windspeed"),
            "weathercode": cw.get("weathercode"),
            "description": _wmo_desc(cw.get("weathercode")),
            "is_day": cw.get("is_day"),
            "time": cw.get("time"),
        }
    except Exception:  # noqa: BLE001 - 天气失败不影响主流程
        return None


def reverse_geocode(lat: float, lon: float) -> Optional[dict[str, str]]:
    """反向地理编码, 返回城市/国家信息。"""
    try:
        resp = requests.get(
            "https://api.bigdatacloud.net/data/reverse-geocode-client",
            params={"latitude": lat, "longitude": lon, "localityLanguage": "zh"},
            headers={"User-Agent": _USER_AGENT},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        d = resp.json()
        city = d.get("city") or d.get("locality") or ""
        return {
            "city": city,
            "country": d.get("countryName", ""),
            "countryCode": d.get("countryCode", ""),
            "subdivision": d.get("principalSubdivision", ""),
        }
    except Exception:  # noqa: BLE001
        return None


def get_context(lat: float, lon: float) -> dict[str, Any]:
    """聚合天气 + 位置信息。"""
    return {
        "latitude": lat,
        "longitude": lon,
        "weather": get_weather(lat, lon),
        "location": reverse_geocode(lat, lon),
    }
