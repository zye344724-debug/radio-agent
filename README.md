# RadioAgent · 在地球上发现下一家电台

旋转地球，听见世界。RadioAgent 将全球在线电台放到可交互的 3D 地球上，也能根据一句话、所在地区与此刻的天气推荐适合收听的频道。

**[立即体验公开版](https://radio-agent-global-zy.warmoasis1.chatgpt.site/)**

## 你可以做什么

- **探索地图**：旋转、放大地球，自动显示当前区域的电台；点击地图圆点或名称即可播放。
- **用一句话选台**：试试“深夜想听爵士”或“跑步时听电子乐”，按风格、地区和语言寻找频道。
- **获得此刻推荐**：结合可选的定位、天气和时间，找到符合当下情境的电台。
- **按自己的方式浏览**：搜索电台名称、筛选标签与语言，并切换随时间变化的界面主题。
- **选择 AI 增强**：默认使用规则解析；在设置中填写自己的 API Key 后，可启用兼容 OpenAI 接口的模型辅助理解需求。

电台目录来自 [Radio Browser](https://www.radio-browser.info/)。播放地址由各电台提供，部分频道可能因源站失效、浏览器格式支持或地区网络限制而无法播放。地图只展示提供有效坐标的电台，单个国家或地区最多加载 500 个点位。

## 本地运行

需要 Python 3.9+：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd backend
uvicorn main:app --host 127.0.0.1 --port 8000
```

打开 [http://127.0.0.1:8000/](http://127.0.0.1:8000/)。电台搜索与规则推荐无需 API Key。若要使用模型辅助选台，可在网页设置中填写自己的 Key。本地开发也可以在 `backend/.env` 中配置 `DEEPSEEK_API_KEY`，供后端生成时段文案；对话解析仍以访客自己的 Key 为准。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `frontend/` | 原生 HTML、CSS、JavaScript 页面，使用 MapLibre GL 绘制 3D 地球 |
| `backend/` | 本地 FastAPI 服务、Radio Browser 代理与推荐逻辑 |
| `site-deployment/` | 公开版部署源码，使用 Cloudflare Worker 提供同源 API 与静态资源 |

公开版与本地版使用同一套前端。播放流直接来自电台源站；搜索、地理点位和推荐通过本站 API 获取。

## 关于 API Key

网页设置中的 Key 保存在当前浏览器的本地存储中。使用 AI 功能时，Key 会随请求发送到本站服务端，再由服务端转发给所配置的模型服务；仓库不包含任何私有 Key。不填写 Key 也可以使用地图、搜索、播放和规则推荐。

## 主要接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/stations/search` | 搜索电台 |
| `GET` | `/api/stations/geo` | 获取地图电台点位 |
| `GET` | `/api/recommend` | 按风格、地区与语言推荐 |
| `POST` | `/api/intent` | 解析自然语言需求 |
| `POST` | `/api/personalize` | 根据位置、天气和时间推荐 |
| `GET` | `/api/meta/tags`、`/api/meta/countries`、`/api/meta/languages` | 筛选数据 |

这是一个持续完善中的个人项目。欢迎通过 Issue 反馈电台播放、地图显示和使用体验问题。
