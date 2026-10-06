# Контекст проекта

- Проект: backend API маркетплейса Bradobrey.
- Рабочая директория: `D:\api.bradobrey.uz`.
- Стек: Node.js, Express, PostgreSQL, Socket.IO.
- Источник продуктовых требований: `C:\Users\admin\Documents\Bradobrey\ТЗ_Маркетплейс_v1.pdf`.
- Авторизация по телефону использует Telegram MTProto OTP; универсальный OTP
  fallback удалён. Legacy `/phone/*` endpoints должны направлять потребителей
  на `/telegram/*`.
- Аудит 2026-10-03: backend не готов к production; подробности в `API_TZ_COMPLIANCE_AUDIT.md` и `SECURITY.md`.

## Ограничения текущей проверки

- Проверка исходного кода и локальных тестов выполнена без изменения runtime-кода.
- Подключение к PostgreSQL не прошло из-за ошибки аутентификации, поэтому фактически применённая схема и production-данные не подтверждены.
- FCM/SMS, reverse proxy, PM2 restart и production deployment не проверялись в живой среде.
