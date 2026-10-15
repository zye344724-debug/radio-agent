# Radio Agent · 全球电台智能推荐

一个 **AI-Native 的音乐电台 Agent**：用自然语言描述需求，自动搜索全球电台并给出个性化推荐，一键播放。

> 作品集 Demo —— 展示「自然语言理解 → 结构化检索 → 个性化推荐 → 播放反馈」的完整 Agent 链路。

## 功能

- 🌍 **全球电台搜索**：接入 [Radio Browser API](https://www.radio-browser.info/)（社区维护、免费免 Key），收录数万个在线电台
- 💬 **对话式选台**：输入「深夜想听点爵士」「日本的电子乐」「跑步时的嗨曲」等自然语言，自动解析为风格/地区/语言/场景
- 🎯 **个性化推荐**（规则版）：风格 + 国家 + 语言组合检索，多级降级策略保证总能给出结果
- ▶️ **在线播放**：HTML5 播放器直接播放电台流
- 📈 **反馈闭环**：播放时上报点击，反哺 Radio Browser 的推荐排序

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | FastAPI | REST API + 静态资源服务 |
| 数据源 | Radio Browser API | 多镜像自动故障切换 |
| 意图解析 | 规则关键词映射 | 可无缝替换为 LLM |
| 前端 | 原生 HTML/CSS/JS | 聊天 + 播放器 + 推荐列表 |

## 目录结构

```
radio-agent/
├── backend/
│   ├── main.py        # FastAPI 应用与路由
│   ├── radio_api.py   # Radio Browser API 封装 (故障切换)
│   └── intent.py      # 自然语言意图解析 (规则版)
├── frontend/
│   ├── index.html     # 页面结构
│   ├── style.css      # 深色主题样式
│   └── app.js         # 交互逻辑
└── requirements.txt
```

## 运行

```bash
cd radio-agent/backend
pip install -r ../requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

浏览器打开 http://localhost:8000

公开版：[RadioAgent 全球电台](https://radio-agent-global-zy.warmoasis1.chatgpt.site/)。部署源码位于 `site-deployment/`，不包含本机的 `backend/.env`；公开站点的 AI 功能由访客自行填写 API Key。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/meta/tags` | 热门风格标签 |
| GET | `/api/meta/countries` | 国家列表 |
| GET | `/api/meta/languages` | 语言列表 |
| GET | `/api/stations/search` | 按名称/标签/国家/语言搜索 |
| POST | `/api/intent` | 自然语言意图解析 |
| GET | `/api/recommend` | 个性化推荐（含降级策略） |
| POST | `/api/click` | 播放点击上报 |

## 个性化推荐策略

1. 多标签（AND）+ 国家 + 语言 全命中
2. 去掉语言约束
3. 去掉国家约束
4. 单标签降级
5. 全局热门兜底

## 后续可扩展方向

- 接入 LLM（如 DeepSeek/GPT）替换规则意图解析，支持更模糊的情绪/场景表达
- 用户偏好记忆（本地 localStorage 或后端存储）
- 播放历史与「猜你喜欢」协同过滤
- 电台可用性健康检查与自动跳过失效源
