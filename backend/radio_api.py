"""
Radio Browser API 封装层。

数据源: https://www.radio-browser.info/ (社区维护的全球在线电台数据库, 免费、免 Key)
- 提供多个镜像服务器, 此处实现自动故障切换
- 关键字段: name / country / countrycode / language / tags / url / url_resolved / favicon / bitrate / codec / votes / clickcount
"""
from __future__ import annotations

import random
from typing import Any, Optional

import requests

# Radio Browser 的多个官方镜像 (按优先级轮询, 单个失败自动切换)
_MIRRORS = [
    "https://de1.api.radio-browser.info",
    "https://nl1.api.radio-browser.info",
    "https://at1.api.radio-browser.info",
    "https://all.api.radio-browser.info",
]

_TIMEOUT = 12  # 秒
_USER_AGENT = "RadioAgent/1.0 (portfolio demo)"

_session = requests.Session()
_session.headers.update({"User-Agent": _USER_AGENT})


def _get(path: str, params: Optional[dict] = None) -> list[dict[str, Any]]:
    """向 Radio Browser 发起 GET 请求, 镜像故障时自动切换到下一个。"""
    params = params or {}
    last_err: Optional[Exception] = None
    mirrors = _MIRRORS[:]
    random.shuffle(mirrors)
    for base in mirrors:
        url = f"{base}{path}"
        try:
            resp = _session.get(url, params=params, timeout=_TIMEOUT)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001 - 故障切换需要捕获所有网络异常
            last_err = exc
            continue
    raise RuntimeError(f"Radio Browser API 全部镜像不可用: {last_err}")


def search_stations(
    *,
    name: str = "",
    tag: str = "",
    countrycode: str = "",
    language: str = "",
    tags: Optional[list[str]] = None,
    limit: int = 20,
    order: str = "clickcount",
    reverse: bool = True,
    hidebroken: bool = True,
) -> list[dict[str, Any]]:
    """搜索电台。

    order 可选: name / url / votes / clickcount / bitrate / lastcheckok / country / language
    tags: 多标签时需同时命中 (Radio Browser 要求空格分隔)
    """
    params: dict[str, Any] = {
        "hidebroken": str(hidebroken).lower(),
        "order": order,
        "reverse": str(reverse).lower(),
        "limit": min(limit, 100),
    }
    if name:
        params["name"] = name
    if tag:
        params["tag"] = tag
    if countrycode:
        params["countrycode"] = countrycode
    if language:
        params["language"] = language
    if tags:
        params["tagList"] = ",".join(tags)
    if countrycode != "CN":
        return _get("/json/stations/search", params)

    # 地图把台湾地区并入中国选区；Radio Browser 的检索码仍分别为 CN/TW。
    combined: list[dict[str, Any]] = []
    last_error: Optional[Exception] = None
    for code in ("CN", "TW"):
        try:
            combined.extend(_get("/json/stations/search", {**params, "countrycode": code}))
        except Exception as exc:  # 一个地区的接口不可用时仍保留另一个地区的结果
            last_error = exc
    if not combined and last_error:
        raise last_error

    def sort_key(station: dict[str, Any]) -> Any:
        value = station.get(order)
        if order in {"votes", "clickcount", "bitrate", "lastcheckok"}:
            try:
                return float(value or 0)
            except (TypeError, ValueError):
                return 0
        return str(value or "").lower()

    unique = {s.get("stationuuid") or id(s): s for s in combined}
    return sorted(unique.values(), key=sort_key, reverse=reverse)[: min(limit, 100)]


def geo_stations(countrycode: str, limit: int = 500) -> list[dict[str, Any]]:
    """取得一个国家或地区带坐标的可播放电台，供地图独立加载。"""
    codes = ("CN", "TW") if countrycode == "CN" else (countrycode,)
    stations: list[dict[str, Any]] = []
    last_error: Optional[Exception] = None
    for code in codes:
        try:
            stations.extend(_get("/json/stations/search", {
                "countrycode": code,
                "has_geo_info": "true",
                "is_https": "true",
                "hidebroken": "true",
                "order": "clickcount",
                "reverse": "true",
                "limit": (limit + 1) // 2 if countrycode == "CN" else limit,
            }))
        except Exception as exc:
            last_error = exc
    if not stations and last_error:
        raise last_error
    return list({s.get("stationuuid") or id(s): s for s in stations}.values())[:limit]


def get_tags(limit: int = 100) -> list[dict[str, Any]]:
    """获取标签列表 (附带电台数量, 用于前端筛选热门风格)。"""
    return _get("/json/tags", {"limit": limit, "order": "stationcount", "reverse": "true", "hidebroken": "true"})


def get_countries() -> list[dict[str, Any]]:
    """获取国家列表 (附带电台数量)。"""
    return _get("/json/countries", {"order": "stationcount", "reverse": "true"})


def get_languages() -> list[dict[str, Any]]:
    """获取语言列表。"""
    return _get("/json/languages", {"order": "stationcount", "reverse": "true"})


def register_click(stationuuid: str) -> None:
    """向 Radio Browser 上报一次点击 (用于提升该电台的推荐权重)。"""
    try:
        _get(f"/json/url/{stationuuid}")
    except Exception:  # noqa: BLE001 - 点击上报失败不影响主流程
        pass


def stations_by_click(stationuuid: str) -> list[dict[str, Any]]:
    """按 uuid 精确查询单个电台。"""
    return _get(f"/json/stations/byuuid/{stationuuid}")
