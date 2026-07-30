/**
 * HTML → readable plain text, for DISPLAYING third-party content (Chub card descriptions
 * are frequently full styled HTML pages). Strips style/script blocks and tags while
 * keeping line structure, and decodes HTML entities (&#39;, &eacute;, &rsquo;…) so
 * accents and apostrophes render correctly.
 *
 * Display-only: imported card data keeps its raw content (SillyTavern-compatible).
 */

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    eacute: 'é',
    egrave: 'è',
    ecirc: 'ê',
    euml: 'ë',
    agrave: 'à',
    acirc: 'â',
    ccedil: 'ç',
    ocirc: 'ô',
    ouml: 'ö',
    icirc: 'î',
    iuml: 'ï',
    ucirc: 'û',
    ugrave: 'ù',
    uuml: 'ü',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    laquo: '«',
    raquo: '»',
};

function decodeEntities(s: string): string {
    // Browser: the textarea trick decodes EVERY entity correctly (never executes markup).
    if (typeof document !== 'undefined') {
        const el = document.createElement('textarea');
        el.innerHTML = s;
        return el.value;
    }
    // Node/SSR fallback: numeric entities + the common named set.
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            try {
                return String.fromCodePoint(parseInt(hex, 16));
            } catch {
                return '';
            }
        })
        .replace(/&#(\d+);/g, (_, dec) => {
            try {
                return String.fromCodePoint(parseInt(dec, 10));
            } catch {
                return '';
            }
        })
        .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** Extract readable text from (possibly) HTML content. Plain text passes through as-is. */
export function htmlToPlainText(input: string): string {
    if (!input) return '';
    if (!/[<&]/.test(input)) return input; // fast path: nothing to do

    let t = input;
    // CSS/JS blocks would leak their source into textContent — drop them whole.
    t = t.replace(/<(style|script|template)[^>]*>[\s\S]*?<\/\1>/gi, '');
    t = t.replace(/<!--[\s\S]*?-->/g, '');
    // Keep line structure that tags implied.
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, '\n');
    t = t.replace(/<li[^>]*>/gi, '• ');
    // Strip every remaining tag.
    t = t.replace(/<[^>]+>/g, '');
    t = decodeEntities(t);
    // Tidy whitespace without flattening paragraphs.
    t = t
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    return t;
}
