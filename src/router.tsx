import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { supabase } from "@/integrations/supabase/client";

export const getRouter = () => {
  const queryClient = new QueryClient();

  // Cached server data belongs to the signed-in user. Drop it whenever the
  // session's user changes, so a later sign-in in the same tab never sees the
  // previous account's properties, reports or authorizations.
  if (typeof window !== "undefined") {
    let currentUserId: string | null | undefined;
    supabase.auth.onAuthStateChange((_event, session) => {
      const next = session?.user?.id ?? null;
      if (currentUserId !== undefined && next !== currentUserId) queryClient.clear();
      currentUserId = next;
    });
  }

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
