/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    // Don't bundle these — they need native Node.js resolution (WASM, ONNX
    // runtime). @pinecone-database/pinecone was the missing one: the
    // dynamic import in lib/embeddings.getPinecone() resolved to "Cannot
    // find package" at runtime on Vercel, so every Pinecone search
    // silently returned no results.
    serverComponentsExternalPackages: [
      "@xenova/transformers",
      "onnxruntime-node",
      "@pinecone-database/pinecone",
    ],
    // Force-include the @xenova/transformers WASM binaries into every
    // /api/** function bundle. Vercel's tracer follows JS imports but
    // doesn't pick up sibling .wasm files the JS opens via fs.open() at
    // runtime — which is exactly how onnxruntime loads its backend.
    // Without this, the Lambda errors with
    //   "ENOENT: no such file or directory, open
    //    '/var/task/node_modules/@xenova/transformers/dist/ort-wasm-simd.wasm'"
    // and CLIPTextModelWithProjection.from_pretrained throws.
    outputFileTracingIncludes: {
      "/api/**/*": [
        "./node_modules/@xenova/transformers/dist/*.wasm",
        "./node_modules/@xenova/transformers/dist/*.mjs",
      ],
    },
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.asos-media.com" },
      { protocol: "https", hostname: "**.bloomingdales.com" },
      { protocol: "https", hostname: "**.ediktedclothing.com" },
      { protocol: "https", hostname: "**.hellomolly.com" },
      { protocol: "https", hostname: "**.nordstrom.com" },
      { protocol: "https", hostname: "**.nordstromimage.com" },
      { protocol: "https", hostname: "**.revolve.com" },
      { protocol: "https", hostname: "i.pinimg.com" },
      // catch-all for other CDN subdomains
      { protocol: "https", hostname: "**" },
    ],
  },
};

module.exports = nextConfig;
