import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

export async function GET(request: NextRequest) {
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });

  console.log("[boards] token exists:", !!token, "accessToken:", !!token?.accessToken);

  if (!token?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const res = await fetch(
    "https://api.pinterest.com/v5/boards?page_size=50",
    {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  const data = await res.json();
  console.log("[boards] Pinterest status:", res.status, "items count:", data.items?.length ?? 0);

  if (!res.ok) {
    console.error("[boards] Pinterest error:", JSON.stringify(data).slice(0, 300));
    return NextResponse.json({ error: "Failed to fetch boards" }, { status: res.status });
  }

  const boards = (data.items ?? []).map((b: { id: string; name: string }) => ({
    id: b.id,
    name: b.name,
  }));

  console.log("[boards] returning", boards.length, "boards");
  return NextResponse.json({ boards });
}
