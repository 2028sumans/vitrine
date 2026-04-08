import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function GET() {
  const session = await getServerSession(authOptions);

  console.log("[boards] session exists:", !!session, "accessToken:", !!session?.accessToken);

  if (!session?.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const res = await fetch(
    "https://api.pinterest.com/v5/boards?page_size=50",
    {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );

  const data = await res.json();
  console.log("[boards] Pinterest status:", res.status, "keys:", Object.keys(data), "items count:", data.items?.length ?? 0);

  if (!res.ok) {
    console.error("[boards] Pinterest error:", JSON.stringify(data).slice(0, 300));
    return NextResponse.json({ error: "Failed to fetch boards" }, { status: res.status });
  }

  // Normalize to { id, name } shape
  const boards = (data.items ?? []).map((b: { id: string; name: string }) => ({
    id: b.id,
    name: b.name,
  }));

  return NextResponse.json({ boards });
}
