# RadioAgent public site

This directory is the source snapshot of the [public RadioAgent site](https://radio-agent-global-zy.warmoasis1.chatgpt.site/). It contains a Cloudflare Worker API and static frontend assets. Build with `bash scripts/build.sh`, then validate with `node scripts/validate-artifact.mjs`.

The public site does not include `backend/.env` or a shared AI key. Visitors may enter their own AI key in the site's settings. Station search returns HTTPS streams so browsers can play them on an HTTPS page.

The local FastAPI version lives in `../backend` and `../frontend`.
