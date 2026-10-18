# Telegram bot unsolicited advertisement messages — 2026-10-17

## Conclusion

The supplied screenshots show advertisement text and a CTA button as ordinary messages in the bot conversation history. They are not Telegram's sponsored-message/action-bar placement above the chat. Telegram's current documentation distinguishes bot ads as advertisements shown above a private bot chat, while the screenshots show persistent message bubbles in the conversation.

The current repository's bot handlers send login OTP and phone-verification/onboarding messages; no advertising copy or ad-dispatch function was found in the Telegram service/router. Therefore the messages are not explained by the current checked-in Telegram auth flow. Likely causes are an unauthorized holder of the bot token, another backend/process using the same bot token, or a different deployed codebase. The screenshots alone cannot distinguish these.

## Evidence

- Screenshot evidence: unsolicited promotional message bubbles and CTA buttons appear among the normal authentication conversation. The promoted content is unrelated to Bradobrey.
- `src/services/telegram-bot.service.js:45-47` wraps Bot API `sendMessage`; it sends only the text supplied by the service caller.
- `src/services/telegramAuth.js:122` sends the login OTP. Its webhook handlers send fixed phone-confirmation, invalid/expired link, and error/help prompts at approximately lines 280-340. No ad copy or advertisement scheduler was found under `src/services` or Telegram routes.
- `.env.example` is tracked by Git and contains a value in the Telegram bot token format. A redacted history scan found a token-shaped value in tracked template revisions `14b4744d` (2026-10-07) and `a76ad5d7` (2026-10-14). The value is not reproduced here.
- Local `.env` exists but does **not** contain `TELEGRAM_BOT_TOKEN`; therefore the local runtime credential cannot be compared to the tracked template value. The production token, whether it matches the published value, and whether the value remains active are unknown.

## Assessment

**High-priority credential exposure / bot control risk; active compromise not conclusively proven.** Anyone who obtained a valid Bot API token can send messages as that bot. Since the token-shaped value is in tracked source history and the observed messages are sent as the bot, token misuse is a plausible cause. However, no live Bot API calls or production logs were used, and the actual production token was not available for safe comparison.

Telegram itself is a separate possible source only if an advertisement is a sponsored UI bar above the conversation; that does not match the supplied message-bubble screenshots. Telegram's official docs describe that UI as an action bar for ads returned for a private bot chat: https://core.telegram.org/api/action-bar#bot-ads. Official sponsored-message display rules place bot ads above the chat: https://core.telegram.org/api/sponsored-messages#displaying-sponsored-messages.

## Recommended containment and attribution

1. In BotFather, revoke the current token for this bot and issue a new one. Update the production secret store only; do not put the replacement in `.env.example`, Git, logs, or chat. Coordinate the change with every running instance so the old token stops working everywhere.
2. Replace credential-shaped values in `.env.example` with unmistakable placeholders. Treat the old value as exposed because it is present in Git history; removing the latest copy alone does not remove historical exposure.
3. Inspect production deployment inventory for duplicate PM2/containers/legacy servers that may share the bot token, and review logs around the screenshot timestamps for unexpected Bot API sends or token rejection after revocation.
4. Confirm the webhook URL and Telegram `getWebhookInfo` using the newly rotated credential through a trusted secret-handling process. Do not paste tokens into logs or diagnostic output.

No production systems, Telegram Bot API, or credentials were accessed during this investigation. No files containing active secrets were modified.
