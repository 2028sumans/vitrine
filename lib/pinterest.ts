/**
 * Pinterest API client wrapper.
 * All Pinterest API calls go through this module — never call the API directly
 * from components or other API routes.
 */

const PINTEREST_API_BASE = "https://api.pinterest.com/v5";

async function pinterestFetch<T>(
  path: string,
  accessToken: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${PINTEREST_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Pinterest API error ${res.status}: ${error}`);
  }

  return res.json();
}

export interface PinterestBoard {
  id: string;
  name: string;
  description: string;
  pin_count: number;
  media?: { image_cover_url?: string };
}

export interface PinterestPin {
  id: string;
  title?: string;
  description?: string;
  media?: { images?: { "600x"?: { url: string } } };
  link?: string;
}

export async function getUserBoards(
  accessToken: string
): Promise<PinterestBoard[]> {
  const data = await pinterestFetch<{ items: PinterestBoard[] }>(
    "/boards",
    accessToken
  );
  return data.items;
}

export async function getBoardPins(
  boardId: string,
  accessToken: string,
  limit = 50
): Promise<PinterestPin[]> {
  const data = await pinterestFetch<{ items: PinterestPin[] }>(
    `/boards/${boardId}/pins?page_size=${limit}`,
    accessToken
  );
  return data.items;
}

export async function getUserAccount(accessToken: string) {
  return pinterestFetch<{ username: string; profile_image: string }>(
    "/user_account",
    accessToken
  );
}
