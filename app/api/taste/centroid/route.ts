/**
 * POST /api/taste/centroid
 *
 * Persists a cross-session style centroid for a user.
 * Called fire-and-forget at the end of each session.
 *
 * Fetches CLIP embeddings of the liked products from Pinecone,
 * averages them, blends with any existing stored centroid,
 * and saves to Supabase (user_taste_centroids table).
 *
 * Degrades gracefully if Pinecone or DB is unavailable.
 */

import { NextResponse }                      from "next/server";
import { getPineconeIndex, blendCentroids }  from "@/lib/embeddings";
import { saveStyleCentroid, getStyleCentroid } from "@/lib/taste-memory";

export async function POST(request: Request) {
  const { userToken, likedProductIds }: {
    userToken:       string;
    likedProductIds: string[];
  } = await request.json();

  if (!userToken || userToken === "anon" || !likedProductIds?.length) {
    return NextResponse.json({ ok: true });
  }

  try {
    const index   = await getPineconeIndex();
    const fetched = await index.fetch({ ids: likedProductIds });
    const vectors = (Object.values(fetched.records ?? {}) as Array<{ values?: number[] }>)
      .map((r) => Array.from(r.values ?? []))
      .filter((v) => v.length > 0);

    if (vectors.length === 0) return NextResponse.json({ ok: true });

    // Average of liked product embeddings
    const sessionAvg = vectors[0].map((_, i) =>
      vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length
    );

    // Blend with existing centroid (60% existing, 40% new session)
    const existing   = await getStyleCentroid(userToken);
    const newCentroid = existing
      ? blendCentroids(existing, [sessionAvg], 0.4)
      : sessionAvg;

    await saveStyleCentroid(userToken, newCentroid);

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Non-fatal — centroid is a nice-to-have enhancement
    console.warn("[taste/centroid] Failed (non-fatal):", err);
    return NextResponse.json({ ok: true });
  }
}
