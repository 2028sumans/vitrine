import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  // Accept token from Authorization header (sent by client from useSession)
  const auth = request.headers.get("authorization") ?? "";
  const accessToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  console.log("[boards] accessToken present:", !!accessToken, "length:", accessToken?.length ?? 0);

  if (!accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const res = await fetch(
    "https://api.pinterest.com/v5/boards?page_size=50",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  const data = await res.json();
  console.log("[boards] Pinterest status:", res.status, "items count:", data.items?.length ?? 0);

  if (!res.ok) {
    console.error("[boards] Pinterest error:", JSON.stringify(data).slice(0, 300));
    return NextResponse.json({ error: "Failed to fetch boards", detail: data }, { status: res.status });
  }

  const boards = (data.items ?? []).map((b: { id: string; name: string }) => ({
    id: b.id,
    name: b.name,
  }));

  console.log("[boards] returning", boards.length, "boards");
  return NextResponse.json({ boards });
}
