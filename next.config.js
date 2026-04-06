/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
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
