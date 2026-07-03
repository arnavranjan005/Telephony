/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: no Next.js server at runtime at all. The build fails hard
  // if anything tries to use API routes, middleware, or server actions -
  // this admin panel only ever talks to the Express API (NEXT_PUBLIC_API_URL)
  // via client-side fetch. Serve the resulting out/ directory with any static
  // file host/CDN.
  output: "export",
  reactStrictMode: true,
};

module.exports = nextConfig;
