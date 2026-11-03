# MCP-сервер для Kie.ai

Даёт Claude инструменты Kie.ai: картинки (Nano Banana, Seedream, Flux и др.), видео (Veo 3.1, Kling, Sora 2…) и музыку (Suno).
Без зависимостей: нужен только Node.js 18+.

Ключ **никогда не пишется в чат и не хранится в репозитории**. Сервер читает его только из переменной окружения `KIE_API_KEY`.

## Инструменты

| Инструмент | Что делает |
|---|---|
| `kie_credits` | Остаток кредитов |
| `kie_generate` | Создаёт задачу (модель + параметры) и ждёт результат, возвращает ссылки |
| `kie_task_status` | Проверить задачу по `taskId` |
| `kie_upload_file` | Загрузить свою картинку/аудио, чтобы получить ссылку для редактирования |
| `kie_download` | Сохранить готовый файл к себе (ссылки Kie.ai живут ~24 часа) |
| `kie_api_request` | Любой другой метод API Kie.ai |

Примеры моделей: `google/nano-banana`, `google/nano-banana-edit`, `veo-3-1`, `ai-music-api/generate`. Полный список: https://docs.kie.ai/market/quickstart

## Как подключить

### В облачных сессиях Claude (проект «Библия»)

Файл `.mcp.json` в корне репозитория уже подключает сервер. Нужно только окружение с ключом и доступом в сеть:

1. Откройте настройки проекта → **Cloud environment** → **Add cloud environment**.
2. В **Environment variables** добавьте строку `KIE_API_KEY=ваш_ключ` (ключ берётся на https://kie.ai/api-key).
3. В **Network access** выберите уровень **Limited** (или Custom) и в **Allowed domains** добавьте:
   - `api.kie.ai`
   - `kieai.redpandaai.co` (загрузка файлов)
   - `tempfile.aiquickdraw.com`, `file.aiquickdraw.com` (готовые файлы; если скачивание не идёт, Claude подскажет, какой ещё домен открыть)
4. Сохраните. Новые сессии проекта будут работать с Kie.ai.

### Claude Desktop на компьютере

В `claude_desktop_config.json` (Настройки → Developer → Edit Config):

```json
{
  "mcpServers": {
    "kie": {
      "command": "node",
      "args": ["C:/путь/к/bible-app-releases/tools/kie-mcp/server.mjs"],
      "env": { "KIE_API_KEY": "ваш_ключ" }
    }
  }
}
```

Перезапустите Claude Desktop.

### Claude Code на компьютере

```bash
export KIE_API_KEY=ваш_ключ        # Windows: setx KIE_API_KEY ваш_ключ
claude mcp add kie -- node /путь/к/tools/kie-mcp/server.mjs
```

## Настройки (необязательно)

- `KIE_API_BASE` — адрес API (по умолчанию `https://api.kie.ai`)
- `KIE_UPLOAD_BASE` — адрес загрузки файлов (по умолчанию `https://kieai.redpandaai.co`)

Каждая генерация тратит кредиты Kie.ai.
