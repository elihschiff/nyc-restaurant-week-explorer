import type { NextConfig } from "next";

const pagesBasePath = process.env.PAGES_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: pagesBasePath,
  assetPrefix: pagesBasePath || undefined,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
