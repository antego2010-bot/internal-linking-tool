/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [{ source: "/", destination: "/index.html" }];
  },
  async headers() {
    return [{
      // Pages served on mozapitools.app call this tool's API directly
      source: "/api/:path*",
      headers: [
        { key: "Access-Control-Allow-Origin", value: "https://mozapitools.app" },
        { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
        { key: "Access-Control-Allow-Headers", value: "content-type, x-claude-key, x-moz-token, x-body-encoding" },
        { key: "Access-Control-Expose-Headers", value: "x-library-encoding" },
        { key: "Access-Control-Max-Age", value: "86400" },
        { key: "Vary", value: "Origin" },
      ],
    }, {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
};
export default nextConfig;
