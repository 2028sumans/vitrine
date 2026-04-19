# Category hero images

Hero images for the `/shop` category picker tiles, referenced by
`app/api/category-index/route.ts` via the `CATEGORY_IMAGE_OVERRIDE` map.

These exist because Algolia's underlying category tags are inconsistent
enough that picking a good hero algorithmically keeps returning the wrong
thing (e.g. a hoodie under "Shoes"). When that happens, drop a manual hero
here and map it in the route.

## File naming

- One image per category label, lowercased, spaces → dashes. Examples:
  - `shoes.jpg`
  - `bags-and-accessories.jpg`
  - `outerwear.jpg`

## Recommended specs

- 3:4 aspect (the card container is `aspect-[3/4]`)
- ~900px wide is plenty (the card renders ≤400px; 2× retina)
- JPG preferred for product photos, PNG if the asset has transparency
- Under ~200 KB — these ship to every visitor on /shop
