import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { requireServerEnv } from "@/lib/server-env";

export function createServerUserClient(accessToken: string): SupabaseClient {
  return createClient(
    requireServerEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireServerEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    }
  );
}

export function createServiceRoleClient(): SupabaseClient {
  return createClient(
    requireServerEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireServerEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  );
}

export async function authenticateRequest(request: NextRequest): Promise<{
  user: User;
  accessToken: string;
  client: SupabaseClient;
}> {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("AUTH_REQUIRED");
  const accessToken = match[1];
  const client = createServerUserClient(accessToken);
  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) {
    const authError = error as { code?: unknown; status?: unknown } | null;
    console.warn("[Server Auth] JWT validation failed", {
      code: typeof authError?.code === "string" ? authError.code : "missing_user",
      status: typeof authError?.status === "number" ? authError.status : null,
    });
    throw new Error("AUTH_REQUIRED");
  }
  return { user: data.user, accessToken, client };
}
