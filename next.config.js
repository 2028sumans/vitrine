/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Don't bundle these — they need native Node.js resolution (WASM, ONNX runtime)
  serverExternalPackages: ["@xenova/transformers", "onnxruntime-node"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Belt-and-suspenders: also mark as webpack externals so the bundler
      // never tries to resolve them even with dynamic imports.
      const prev = config.externals || [];
      config.externals = [
        ...(Array.isArray(prev) ? prev : [prev]),
        function ({ request }, callback) {
          const skip = ["@xenova/transformers", "onnxruntime-node", "onnxruntime-web"];
          if (skip.some((pkg) => request === pkg || request.startsWith(pkg + "/"))) {
            return callback(null, "commonjs " + request);
          }
          callback();
        },
      ];
    }
    return config;
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
