-- divieight — flag instruments that carry a buyer-side commission provision.
--
-- When set, the instrument cannot resolve as authorized (i.e. be tendered)
-- until the Heavy Lifting Agent has proposed the provision AND every Preferred
-- Member has separately authorized it — even if the members authorize the
-- instrument before the HLA acts.
--
-- Run this in the external Supabase SQL editor.

ALTER TABLE public.authorization_requests
  ADD COLUMN IF NOT EXISTS commission_expected boolean NOT NULL DEFAULT false;
