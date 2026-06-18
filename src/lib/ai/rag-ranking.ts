import type { Message, WorldState } from '@/types/chat';

type SearchableMessage = Pick<Message, 'role' | 'content'>;

interface RetrievalQueryOptions {
    recentMessages?: SearchableMessage[];
    worldState?: WorldState;
    maxRecentMessages?: number;
}

const STOP_WORDS = new Set([
    'the',
    'and',
    'for',
    'with',
    'that',
    'this',
    'from',
    'you',
    'your',
    'she',
    'her',
    'him',
    'his',
    'they',
    'them',
    'their',
    'was',
    'were',
    'are',
    'but',
    'not',
    'all',
    'into',
    'out',
    'about',
    'what',
    'when',
    'where',
    'how',
    'why',
    'then',
    'than',
    'did',
    'does',
    'had',
    'has',
    'have',
    'just',
    'like',
    'current',
    'turn',
    'recent',
    'scene',
    'assistant',
    'user',
    'location',
    'inventory',
    'known',
    'relationships',
    'le',
    'la',
    'les',
    'des',
    'une',
    'un',
    'du',
    'de',
    'dans',
    'sur',
    'avec',
    'pour',
    'par',
    'qui',
    'que',
    'quoi',
    'quand',
    'comment',
    'est',
    'sont',
    'etait',
    'etaient',
    'elle',
    'elles',
    'ils',
    'nous',
    'vous',
    'toi',
    'moi',
    'son',
    'ses',
    'leur',
    'leurs',
    'mais',
    'pas',
    'plus',
    'tout',
    'tous',
    'tres',
]);

export function buildRetrievalQueryText(
    queryText: string,
    options: RetrievalQueryOptions = {}
): string {
    const { recentMessages = [], worldState, maxRecentMessages = 5 } = options;
    const parts: string[] = [];
    const trimmedQuery = queryText.trim();

    if (trimmedQuery) {
        parts.push(`Current turn: ${trimmedQuery}`);
    }

    const recent = recentMessages
        .filter((message) => message.role !== 'system' && message.content.trim())
        .slice(-maxRecentMessages)
        .map((message) => `${message.role}: ${message.content.trim()}`);

    if (recent.length > 0) {
        parts.push(`Recent scene:\n${recent.join('\n')}`);
    }

    const worldStateText = formatWorldStateForSearch(worldState);
    if (worldStateText) {
        parts.push(worldStateText);
    }

    return parts.join('\n\n').slice(0, 4000);
}

export function extractSearchTerms(text: string): Set<string> {
    const normalized = normalizeForSearch(text);
    const matches = normalized.match(/[a-z0-9][a-z0-9'-]{2,}/g) || [];
    const terms = new Set<string>();

    for (const match of matches) {
        const term = match.replace(/^['-]+|['-]+$/g, '');
        if (term.length < 3 || STOP_WORDS.has(term)) continue;
        terms.add(term);
    }

    return terms;
}

export function lexicalOverlapScore(
    queryTerms: Set<string>,
    content: string,
    extraTerms: string[] = []
): number {
    if (queryTerms.size === 0) return 0;

    const candidateTerms = extractSearchTerms([content, ...extraTerms].join(' '));
    if (candidateTerms.size === 0) return 0;

    let overlap = 0;
    for (const term of queryTerms) {
        if (candidateTerms.has(term)) overlap++;
    }

    const denominator = Math.min(8, Math.max(1, queryTerms.size));
    return Math.min(1, overlap / denominator);
}

function normalizeForSearch(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9'\-\s]/g, ' ');
}

function formatWorldStateForSearch(worldState?: WorldState): string {
    if (!worldState) return '';

    const parts: string[] = [];
    if (worldState.location?.trim()) parts.push(`Location: ${worldState.location.trim()}`);
    if (worldState.inventory?.length) parts.push(`Inventory: ${worldState.inventory.join(', ')}`);

    const relationshipNames = Object.keys(worldState.relationships || {});
    if (relationshipNames.length > 0) {
        parts.push(`Known relationships: ${relationshipNames.join(', ')}`);
    }

    return parts.length > 0 ? `Scene anchors:\n${parts.join('\n')}` : '';
}
