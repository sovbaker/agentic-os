#!/bin/bash
# Ежедневный дамп базы с ротацией.
#
# Цикл в контейнере, а не cron на хосте: так бэкап живёт в том же
# описании, что и всё остальное, и переезжает на новую машину вместе с
# ним. Проверка восстановлением — в docs/12-deploy.md; бэкап, из
# которого ни разу не восстанавливались, бэкапом не является.

set -euo pipefail

DIR=/backups
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$DIR"

while true; do
  STAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
  FILE="$DIR/agentic_os-$STAMP.sql.gz"

  if pg_dump -h db -U agentic -d agentic_os --no-owner | gzip > "$FILE.part"; then
    # Переименование атомарно: файл без .part — всегда целый дамп,
    # а не половина того, что писалось в момент отключения питания.
    mv "$FILE.part" "$FILE"
    echo "{\"level\":\"info\",\"msg\":\"бэкап готов\",\"file\":\"$FILE\",\"bytes\":$(stat -c%s "$FILE")}"
  else
    rm -f "$FILE.part"
    echo "{\"level\":\"error\",\"msg\":\"бэкап не удался\",\"at\":\"$STAMP\"}" >&2
  fi

  find "$DIR" -name 'agentic_os-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

  sleep 86400
done
