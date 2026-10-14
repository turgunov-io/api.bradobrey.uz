# Findings

## BS-SESSION-001 — High: TTL не соответствует требованию 15 часов

- Evidence: `src/models/barbers.js:136-145` использует `process.env.JWT_EXPIRES_IN || '12h'`; локальный `.env` содержит `JWT_EXPIRES_IN=12h`.
- Expected: token validity 15h, если это утверждённая политика владельца.
- Impact: при отсутствии обновления токена штатный expiry наступает через 12h.
- Production status: не подтверждён из-за отсутствия SSH.

## BS-SESSION-002 — High: любой 401 превращается в logout

- Evidence: `BarberRemoteDataSourceImpl._throwIfUnauthorized` вызывает `SessionExpirationService.forceReauth`; `PresenceService` делает то же для heartbeat 401.
- Expected: logout только для подтверждённого expired/invalid/revoked token; временные ошибки сети и server-side presence issues не должны удалять локальную сессию.
- Impact: единичный 401 от reverse proxy, смены JWT secret, старого deployment, user access state или endpoint-маршрутизации выглядит для пользователя как logout.
- Note: network exceptions в PresenceService игнорируются, но HTTP 401 не различается по причине.

## BS-SESSION-003 — Medium: midnight привязан к timezone устройства

- Evidence: `midnight_logout_service.dart:47,88-96` использует `DateTime.now()` и `DateTime(now.year, now.month, now.day + 1)`.
- Expected: если бизнес-правило — 00:00 Asia/Tashkent, расчёт должен быть явно Tashkent или device timezone должен быть гарантирован.
- Impact: устройство с неверной timezone выйдет не в ташкентскую полночь.

## BS-SESSION-004 — Medium: midnight service не покрыт тестами

- Evidence: в `bradobrey_barber/test` нет тестов для `MidnightLogoutService`, auth-session timestamp, background/resume или timer at midnight.
- Impact: корректность 00:00, stale timestamp и timer lifecycle не подтверждена автоматикой.

## BS-SESSION-005 — Medium: startup re-login сбрасывает время начала сессии

- Evidence: `StartPage._resolveStartupState` повторно вызывает login при наличии сохранённых credentials; `AuthRepositoryImpl.login` каждый раз записывает `auth_session_started_at = DateTime.now()`.
- Impact: после перезапуска приложения token и midnight-session фактически начинают отсчёт заново; поведение зависит от момента запуска приложения.

## BS-SESSION-006 — Release risk: client branch ahead of origin

- Evidence: `bradobrey_barber`: `main...origin/main [ahead 1]`, локальный commit `f2b9c40` не pushed. Functional midnight service находится в origin history (`29a0ba4`), но текущая локальная версия всё равно не совпадает с remote.

