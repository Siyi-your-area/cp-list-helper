import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { version: process.env.NEXT_PUBLIC_APP_BUILD_VERSION },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
