#!/usr/bin/env bash
# Еженедельное обновление базы блогеров/брендов из живого каталога на brandisapp.ru
# и публикация изменений в GitHub — после пуша Render сам передеплоит brandis-ai
# (autoDeploy включён на коммит в main), и бот на сайте начнёт отвечать по свежим данным.
#
# Нужна переменная окружения GITHUB_TOKEN (fine-grained PAT с правом Contents: Read and
# write на репозиторий brandis-ai) — задаётся в настройках этого Cron Job на Render,
# а не хранится в коде.
set -euo pipefail

REPO_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/svetlanastakova2903-lab/brandis-ai.git"
WORKDIR="$(mktemp -d)"

echo "Клонирую репозиторий..."
git clone --depth 1 "$REPO_URL" "$WORKDIR"
cd "$WORKDIR/backend"

echo "Устанавливаю зависимости..."
npm install --omit=dev

echo "Обновляю каталог из brandisapp.ru..."
node refreshCatalog.js

cd "$WORKDIR"
git config user.email "catalog-bot@brandisapp.ru"
git config user.name "Brandis Catalog Bot"

if git diff --quiet -- backend/data/bloggers.json backend/data/brands.json; then
echo "Изменений в каталоге нет — пропускаю коммит."
exit 0
fi

git add backend/data/bloggers.json backend/data/brands.json
git commit -m "Еженедельное автообновление каталога блогеров и брендов"
git push origin HEAD:main

echo "Готово: изменения запушены, Render передеплоит сервис автоматически."
