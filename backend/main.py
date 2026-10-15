"""
音乐电台 Agent 后端 (FastAPI)。

职责:
1. 代理 Radio Browser API (搜索/元数据)
2. 自然语言意图解析 (规则版)
3. 个性化电台推荐 (规则版: 风格 + 国家 + 语言组合检索, 带降级策略)
4. 点击上报 (反哺推荐排序)

启动: uvicorn main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import agent_llm
import context as context_svc
import intent as intent_parser
import llm
import quotes as quotes_svc
import radio_api

llm.load_env()

app = FastAPI(title="Radio Agent", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


# ---------- 数据模型 ----------
class IntentRequest(BaseModel):
    text: str
    context: Optional[dict] = None
    llm: Optional[dict] = None  # BYOK: 请求级 {api_key, base_url, model}


class PersonalizeRequest(BaseModel):
    latitude: float
    longitude: float
    hour: Optional[int] = None
    llm: Optional[dict] = None  # BYOK: 请求级 {api_key, base_url, model}


class ClickRequest(BaseModel):
    stationuuid: str


# ---------- 工具函数 ----------
def _trim(stations: list[dict]) -> list[dict]:
    """裁剪出前端需要的字段, 避免冗余字段过大。"""
    keys = [
        "stationuuid", "name", "url_resolved", "url", "homepage", "favicon",
        "tags", "country", "countrycode", "language", "codec", "bitrate",
        "votes", "clickcount", "hls", "geo_lat", "geo_long",
    ]
    out = []
    for s in stations:
        out.append({k: s.get(k) for k in keys})
    return out


# ---------- 基础端点 ----------
@app.get("/api/health")
def health():
    return {"status": "ok", "service": "radio-agent"}


@app.get("/api/meta/tags")
def meta_tags(limit: int = Query(80, ge=1, le=200)):
    tags = radio_api.get_tags(limit)
    # 只保留有意义的风格标签 (过滤掉纯引号/重复怪标签)
    cleaned = [t for t in tags if t.get("name") and len(t["name"]) >= 2 and t["stationcount"] > 0]
    return cleaned


@app.get("/api/meta/countries")
def meta_countries():
    return radio_api.get_countries()


@app.get("/api/meta/languages")
def meta_languages():
    return radio_api.get_languages()


# ---------- 搜索 ----------
@app.get("/api/stations/search")
def stations_search(
    name: str = "",
    tag: str = "",
    countrycode: str = "",
    language: str = "",
    limit: int = Query(20, ge=1, le=100),
    order: str = "clickcount",
):
    stations = radio_api.search_stations(
        name=name, tag=tag, countrycode=countrycode, language=language,
        limit=limit, order=order, reverse=True,
    )
    return {"count": len(stations), "stations": _trim(stations)}


# ---------- 地理电台 (3D 地球打点用) ----------
@app.get("/api/stations/geo")
def stations_geo(
    countrycode: str = "",
    tag: str = "",
    limit: int = Query(200, ge=1, le=500),
    order: str = "clickcount",
):
    """返回带经纬度的电台, 供前端 3D 地球打点。只保留 geo_lat/geo_long 有效的电台。"""
    # 多请求一些 (过滤掉无坐标的), 再裁剪到 limit
    stations = radio_api.search_stations(
        countrycode=countrycode,
        tag=tag,
        limit=min(limit * 2, 500),
        order=order,
        reverse=True,
    )
    geo: list[dict] = []
    for s in _trim(stations):
        lat = s.get("geo_lat")
        lon = s.get("geo_long")
        if lat is None or lon is None:
            continue
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        s["geo_lat"] = lat
        s["geo_long"] = lon
        geo.append(s)
        if len(geo) >= limit:
            break
    return {"count": len(geo), "stations": geo}


# ---------- 意图解析 ----------
@app.post("/api/intent")
def parse_intent(req: IntentRequest):
    # BYOK: 只用访客自己的 key 调 LLM; 未配置则直接规则版 (不消耗服务端共享 key)
    if (req.llm or {}).get("api_key", "").strip():
        try:
            return agent_llm.parse_intent(req.text, req.context, req.llm)
        except Exception:  # noqa: BLE001
            pass
    return intent_parser.parse_intent(req.text)


# ---------- LLM 配置状态 (BYOK 前端展示用) ----------
@app.get("/api/llm/status")
def llm_status():
    return llm.status()


# ---------- 个性化推荐 (定位 + 天气 + 时间 + LLM) ----------
@app.post("/api/personalize")
def personalize(req: PersonalizeRequest):
    ctx = context_svc.get_context(req.latitude, req.longitude)
    hour = req.hour if req.hour is not None else datetime.now().hour
    # BYOK: 访客填了自己的 key 才走 LLM, 否则规则兜底 (不消耗服务端共享 key)
    llm_cfg = req.llm if (req.llm or {}).get("api_key", "").strip() else None
    rec = agent_llm.personalize(
        req.latitude, req.longitude, hour,
        ctx.get("weather"), ctx.get("location"),
        llm_cfg=llm_cfg,
    )
    tags = rec.get("tags") or []
    stations: list[dict] = []
    try:
        stations = radio_api.search_stations(
            tags=tags or None,
            countrycode=rec.get("country") or "",
            language=rec.get("language") or "",
            limit=15,
            order="clickcount",
            reverse=True,
        )
    except Exception:  # noqa: BLE001 - 搜索失败返回空列表
        stations = []
    return {
        "explanation": rec.get("explanation", ""),
        "matched": {
            "tags": tags,
            "countrycode": rec.get("country", ""),
            "language": rec.get("language", ""),
        },
        "context": {
            "weather": ctx.get("weather"),
            "location": ctx.get("location"),
            "hour": hour,
        },
        "stations": _trim(stations),
        "count": len(stations),
    }


# ---------- 句子推送 (按时段) ----------
@app.get("/api/quotes")
def get_quotes(hour: Optional[int] = None):
    h = hour if hour is not None else datetime.now().hour
    return quotes_svc.get_quotes(h)


# ---------- 推荐 (规则版个性化) ----------
@app.get("/api/recommend")
def recommend(
    tags: str = "",
    countrycode: str = "",
    language: str = "",
    name: str = "",
    limit: int = Query(15, ge=1, le=50),
):
    """
    推荐策略 (由严格到宽松逐级降级):
      1. 全部条件 (多标签 AND + 国家 + 语言) 命中
      2. 去掉语言
      3. 去掉国家
      4. 单标签 (取第一个标签)
      5. 全局热门兜底
    """
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]

    attempts = []
    if tag_list:
        attempts.append({"tags": tag_list, "countrycode": countrycode, "language": language})
        attempts.append({"tags": tag_list, "countrycode": countrycode, "language": ""})
        attempts.append({"tags": tag_list, "countrycode": "", "language": ""})
        if len(tag_list) > 1:
            attempts.append({"tags": tag_list[:1], "countrycode": countrycode, "language": language})
            attempts.append({"tags": tag_list[:1], "countrycode": "", "language": ""})
    elif countrycode or language:
        attempts.append({"tags": [], "countrycode": countrycode, "language": language})
        attempts.append({"tags": [], "countrycode": countrycode, "language": ""})
        attempts.append({"tags": [], "countrycode": "", "language": language})
    else:
        attempts.append({"tags": [], "countrycode": "", "language": ""})

    stations: list[dict] = []
    used_level: Optional[str] = None
    for i, a in enumerate(attempts):
        try:
            res = radio_api.search_stations(
                name=name,
                tags=a["tags"] or None,
                countrycode=a["countrycode"],
                language=a["language"],
                limit=limit,
                order="clickcount",
                reverse=True,
            )
        except Exception:
            continue
        if res:
            stations = res
            used_level = f"level_{i + 1}"
            break

    return {
        "count": len(stations),
        "stations": _trim(stations),
        "level": used_level,
        "matched": {
            "tags": tag_list,
            "countrycode": countrycode,
            "language": language,
        },
    }


# ---------- 点击上报 ----------
@app.post("/api/click")
def click(req: ClickRequest):
    radio_api.register_click(req.stationuuid)
    return {"ok": True}


# ---------- 前端静态资源 ----------
@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html", headers={"Cache-Control": "no-store"})


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


# ---------- 启动入口 (本地 python main.py 或云部署均可用) ----------
if __name__ == "__main__":
    import os

    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
