# Образ сервера.
#
# Кода на выходе нет: TypeScript исполняется как есть, через tsx. Это не
# лень — проект настроен на `moduleResolution: bundler` и импортирует
# модули без расширений, так что вывод tsc просто не запустился бы в Node
# без переписывания всех импортов. Пока сервер один, цена — доли секунды
# на старте и никакого шага сборки, который может разойтись с исходником.

FROM node:22-slim AS deps

WORKDIR /app

# Манифесты отдельным слоем: они меняются редко, а установка зависимостей —
# самая долгая операция сборки. Копировать нужно все манифесты воркспейсов,
# иначе `npm ci` не сойдётся с lock-файлом.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY packages/contracts/package.json packages/contracts/
COPY packages/evals/package.json packages/evals/
COPY packages/ui-registry/package.json packages/ui-registry/

# Только рабочая область сервера. Без фильтра сюда приехали бы expo и
# react-native — сотни мегабайт, которые серверу не нужны ни на секунду.
RUN npm ci --omit=dev --workspace @agentic-os/api --include-workspace-root

FROM node:22-slim AS runtime

# curl нужен HEALTHCHECK'у; ca-certificates — исходящим запросам к API модели.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json ./
COPY apps/api ./apps/api
COPY packages/contracts ./packages/contracts
COPY packages/evals ./packages/evals

# Не root. Образ Node уже содержит пользователя `node`.
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/health || exit 1

# `node --import tsx`, а не CLI `tsx`: тогда PID 1 — это сам Node, и SIGTERM
# из оркестратора попадает прямо в его обработчик. Через обёртку сигнал
# ходит лишним прыжком, а корректное завершение здесь не украшение —
# на нём держится освобождение аренды задач.
CMD ["node", "--import", "tsx", "apps/api/src/index.ts"]
