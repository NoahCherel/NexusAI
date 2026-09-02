import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    turbopack: {
        // This project lives below another npm checkout on the development machine; pinning
        // the root prevents Next from selecting the parent lockfile and tracing outside Nexus.
        root: process.cwd(),
    },
};

export default nextConfig;
