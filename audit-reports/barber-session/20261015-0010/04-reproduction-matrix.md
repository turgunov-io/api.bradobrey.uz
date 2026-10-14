# Reproduction matrix

| Scenario | Expected | Current evidence |
|---|---|---|
| Login 10:00, app remains open | Local logout at next 00:00; JWT should remain valid 15h by policy | Flutter timer supports midnight; backend local TTL is 12h |
| Login 23:50 | Logout at 00:00 | Implemented by `MidnightLogoutService` |
| App backgrounded over midnight | Logout when resumed | Implemented by resume check, not device-tested |
| Heartbeat returns 401 at 00:30 | Distinguish cause; do not blindly logout on transient condition | Current app always logs out |
| Network timeout | Keep local session | Presence catches exception; other requests may surface error without logout |
| App restart before midnight | Preserve same login session policy | Startup re-login resets session start timestamp |
| Device timezone differs from Tashkent | Use business timezone | Current implementation uses device local timezone |

