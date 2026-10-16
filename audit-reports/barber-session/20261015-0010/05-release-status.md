# Release status

- Audit status: **PARTIALLY PASS / BLOCKED FOR PRODUCTION CONFIRMATION**.
- The code contains midnight logout logic and kiosk presence cleanup, but the requested 15h TTL is not configured locally.
- The observed 30-minute logout cannot be confirmed as midnight behavior from static code. The strongest code-level candidate is a 401-triggered force reauth, most likely from `/barbers/presence` or another API request.
- Production confirmation requires server logs/status and a controlled test account; SSH was previously rejected for all documented users.
- No code or production configuration was changed during this QA audit.
