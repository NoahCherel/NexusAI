This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Development & CI/CD

This project enforces code quality to prevent regressions.

### Available Scripts

- **`npm run lint`**: Runs ESLint to catch errors.
- **`npm run type-check`**: Validates TypeScript types (no emit).
- **`npm run format:check`**: Checks if code matches Prettier style.
- **`npm run format:write`**: Auto-formats code with Prettier.
- **`npm run build`**: Builds the production application.

### Continuous Integration (CI)

A GitHub Actions workflow is active in `.github/workflows/ci.yml`. It runs on every `push` and `pull_request` to `main`:

1.  **Format Check**: Ensures code style consistency.
2.  **Linting**: Static analysis for bugs.
3.  **Type Checking**: Deep TypeScript validation.
4.  **Build**: Verifies production build success.

> **Tip:** Always run `npm run type-check` and `npm run format:check` before pushing!

## Architecture

- **Frontend**: Next.js 15 (App Router), React 19, TailwindCSS 4.
- **State**: Zustand (Global), LocalStorage (Session), IndexedDB (Persistence).
- **Database**: IndexedDB (idb) with normalized schema (v3) separating `conversations` and `messages`.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.
