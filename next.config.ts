import type { NextConfig } from 'next';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This project lives below another npm checkout on the development machine (a package.json
// and lockfile sit in the user's home folder). Pin the root to THIS file's directory, not to
// process.cwd(): a launcher that starts `next dev` from a parent folder would otherwise make
// Next pick the outer lockfile, and Tailwind's `@import 'tailwindcss'` would be resolved from
// that parent — where there is no node_modules — and no page would compile.
const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
    turbopack: {
        root: projectRoot,
    },
    outputFileTracingRoot: projectRoot,
};

export default nextConfig;
