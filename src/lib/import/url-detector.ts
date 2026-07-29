/**
 * Character-sharing platform URL detection for the by-URL importer.
 *
 * Pure and side-effect free (unit-tested; shared by the client UI for early validation and
 * the server route for dispatch). Endpoint patterns follow SillyTavern's importers — the
 * de-facto reference for these platforms.
 */

export type ImportPlatform =
    | 'jannyai'
    | 'chub'
    | 'pygmalion'
    | 'risuai'
    | 'aicharactercards';

export interface DetectedImport {
    platform: ImportPlatform;
    /** Platform-specific identifier (uuid, creator/project path, author/card slug…). */
    id: string;
    /** Human-readable label for UI/error messages. */
    label: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Detect the platform and extract the card identifier from a pasted URL.
 * Returns null when the URL doesn't match any supported platform.
 */
export function detectImportUrl(rawUrl: string): DetectedImport | null {
    let url: URL;
    try {
        url = new URL(rawUrl.trim());
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = decodeURIComponent(url.pathname);

    // JannyAI (JanitorAI mirror): https://jannyai.com/characters/<uuid>_character-name-...
    if (host === 'jannyai.com') {
        const m = path.match(UUID_RE);
        if (m) return { platform: 'jannyai', id: m[0], label: 'JannyAI' };
        return null;
    }

    // Chub / CharacterHub: https://chub.ai/characters/<creator>/<project>
    if (host === 'chub.ai' || host === 'characterhub.org') {
        const m = path.match(/\/characters\/([^/]+)\/([^/?#]+)/);
        if (m) return { platform: 'chub', id: `${m[1]}/${m[2]}`, label: 'Chub.ai' };
        return null;
    }

    // Pygmalion: https://pygmalion.chat/character/<uuid> (uuid anywhere in the path)
    if (host === 'pygmalion.chat') {
        const m = path.match(UUID_RE);
        if (m) return { platform: 'pygmalion', id: m[0], label: 'Pygmalion' };
        return null;
    }

    // RisuAI Realm: https://realm.risuai.net/character/<uuid>
    if (host === 'realm.risuai.net' || host === 'realm.risuai.xyz') {
        const m = path.match(/\/character\/([0-9a-f-]+)/i);
        if (m) return { platform: 'risuai', id: m[1], label: 'RisuAI Realm' };
        return null;
    }

    // AICharacterCards: https://aicharactercards.com/character-cards/<category>/<author>/<card>/
    if (host === 'aicharactercards.com') {
        const segments = path.split('/').filter(Boolean);
        if (segments.length >= 2) {
            const author = segments[segments.length - 2];
            const card = segments[segments.length - 1];
            return { platform: 'aicharactercards', id: `${author}/${card}`, label: 'AICharacterCards' };
        }
        return null;
    }

    return null;
}

/** Hosts accepted by the importer — for UI hints. */
export const SUPPORTED_IMPORT_HOSTS = [
    'jannyai.com',
    'chub.ai',
    'characterhub.org',
    'pygmalion.chat',
    'realm.risuai.net',
    'aicharactercards.com',
];
