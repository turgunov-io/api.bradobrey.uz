-- Rollback of 005_company_scoped_functions.
-- Run manually in one transaction:  psql -v ON_ERROR_STOP=1 -1 -f <file>
--
-- The previous (global) function bodies are not repeated here. Order:
--   1. re-apply the PREVIOUS release's base files (they define the global
--      versions): ./scripts/apply-schema.sh from that release — it replaces
--      marketplace_loyalty_level(points), apply_marketplace_status_points_from_queue,
--      apply_marketplace_referral_bonus_from_queue,
--      apply_referral_bonus_from_completed_queue, recompute_client_rank,
--      recompute_all_client_ranks, on_client_rank_settings_changed;
--   2. then run this file to drop the helpers nothing references any more.
-- Not possible once 007_drop_global_uniques is applied (the global versions need the
-- global uniques on clients.phone / platform_settings.key).

drop function if exists marketplace_loyalty_level(integer, uuid);
drop function if exists public.recompute_company_client_ranks(uuid);
drop function if exists tenant_setting(text, uuid);
delete from schema_migrations where version = '005';
