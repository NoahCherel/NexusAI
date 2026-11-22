import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { SettingsStorageWarning } from '@/components/settings/SettingsStorageWarning';

const inter = Inter({
    variable: '--font-sans',
    subsets: ['latin'],
});

export const metadata: Metadata = {
    title: 'NexusAI - Roleplay AI Platform',
    description:
        'La plateforme de Roleplay AI la plus puissante et accessible. BYOK, Character Cards V2, et fonctionnalités avancées.',
    manifest: '/manifest.json',
    appleWebApp: {
        capable: true,
        statusBarStyle: 'black-translucent',
        title: 'NexusAI',
    },
};

export const viewport: Viewport = {
    themeColor: '#242525',
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
    // Android Chrome 108+: the keyboard only resizes the VISUAL viewport by default, so
    // h-dvh layouts keep the input bar hidden under it. This restores layout resizing.
    interactiveWidget: 'resizes-content',
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="fr" className="dark" suppressHydrationWarning>
            <head>
                {/* Full-bleed: iOS rounds the corners itself (a pre-rounded PNG shows black corners). */}
                <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
                <meta name="apple-mobile-web-app-capable" content="yes" />
                <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
            </head>
            <body className={`${inter.variable} font-sans antialiased`}>
                {children}
                <SettingsStorageWarning />
                <script
                    dangerouslySetInnerHTML={{
                        __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js')
                    .then((reg) => console.log('SW registered:', reg.scope))
                    .catch((err) => console.error('SW registration failed:', err));
                });
              }
            `,
                    }}
                />
            </body>
        </html>
    );
}
