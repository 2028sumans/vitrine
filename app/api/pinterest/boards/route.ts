import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function GET() {
  const session = await getServerSession(authOptions);

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

  if (!res.ok) {
    const text = await res.text();
    console.error("Pinterest boards fetch failed:", text);
    return NextResponse.json({ error: "Failed to fetch boards" }, { status: res.status });
  }

  const data = await res.json();

  // Normalize to { id, name } shape
  const boards = (data.items ?? []).map((b: { id: string; name: string }) => ({
    id: b.id,
    name: b.name,
  }));

  return NextResponse.json({ boards });
}
