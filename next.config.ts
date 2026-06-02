import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/my-reading-app",
  images: { unoptimized: true },
};

export default nextConfig;
