-- Marks the retired per-member columns as legacy. Documentation only: nothing is dropped or changed, and the
-- Golden Ticket, the account roll-up and the adverse-action page keep working. Safe to re-run.
--
--  * background_check_result : written by the old simulated Background Check. Nothing writes it any more; it is
--    only read, for members who went through the old flow. The Eligibility Check's result is eligibility_results.
--  * fcra_consent_at         : now follows the Block 4 Question 5 authorization (set when the member says Yes,
--    cleared if they withdraw it). The record of the authorization itself is eligibility_declarations.
--  * vetting_status          : kept in step with eligibility_results (cleared / held / not_eligible; in_progress
--    when a correction leaves no result). Read by older screens; the result table is the source of truth.

COMMENT ON COLUMN public.account_members.background_check_result IS
  'LEGACY. Written only by the retired simulated Background Check; nothing writes it now. The result lives in eligibility_results.';
COMMENT ON COLUMN public.account_members.fcra_consent_at IS
  'LEGACY mirror of the Block 4 Question 5 authorization (set on Yes, cleared on withdrawal). The record is eligibility_declarations.';
COMMENT ON COLUMN public.account_members.vetting_status IS
  'Kept in step with eligibility_results (cleared / held / not_eligible / in_progress). eligibility_results is the source of truth.';
