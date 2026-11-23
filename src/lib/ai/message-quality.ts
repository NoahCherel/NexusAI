/**
 * Message Quality Scoring
 *
 * Scores message quality/density before processing.
 * Low-quality messages (short OOC, "okay", reactions) are skipped
 * for summarization and fact extraction, saving API calls.
 *
 * Score range: 0–10
 *   0–2: Skip (trivial: "ok", "lol", OOC chatter)
 *   3–4: Low (short dialogue, simple actions)
 *   5–6: Medium (standard RP exchange)
 *   7–8: High (combat, discovery, plot advancement)
 *   9–10: Critical (major reveals, character death, world-changing)
 */

import type { Message } from '@/types/chat';

export interface QualityScore {
    score: number; // 0–10
    label: 'skip' | 'low' | 'medium' | 'high' | 'critical';
    reason: string;
    wordCount: number;
    actionDensity: number; // narrative actions per sentence
}

// OOC patterns that indicate non-RP content
const OOC_PATTERNS = [
    /^\s*\(\(.*\)\)\s*$/, // ((double parens wrapping entire msg))
    /^\s*\[ooc\b/i, // [OOC: ...]
    /^\s*ooc\s*:/i, // OOC: ...
    /^\s*\/\/\s/, // // comment style
];

// Trivial response patterns
const TRIVIAL_PATTERNS = [
    /^(ok|okay|k|yes|no|yeah|nah|sure|fine|alright|yep|nope|mhm|hmm|hm|ah|oh|lol|lmao|haha|heh|xd|gg|ty|thx|thanks|oui|non|ouais|mouais|d'accord|ok\.|ok!|ok\?)\s*[.!?]*$/i,
    /^(:\)|;\)|:D|<3|❤️|😊|👍|🤣|😂|💀)\s*$/,
];

// Action verbs and narrative indicators (indicate RP substance)
const ACTION_PATTERNS = [
    /\b(attack|fight|cast|dodge|block|parry|slash|stab|shoot|throw|grab|push|pull|kick|punch)\w*/i,
    /\b(attaque|frappe|lance|esquive|pare|tranche|poignarde|tire|saisit|pousse|attrape)\w*/i,
    /\b(discover|find|reveal|uncover|explore|investigate|examine|search|open|unlock|solve)\w*/i,
    /\b(découvre|trouve|révèle|explore|examine|cherche|ouvre|déverrouille|résout)\w*/i,
    /\b(say|whisper|shout|scream|murmur|declare|announce|confess|plead|promise|threaten)\w*/i,
    /\b(dit|murmure|crie|déclare|annonce|avoue|supplie|promet|menace)\w*/i,
    /\b(walk|run|climb|swim|fly|teleport|travel|arrive|enter|leave|escape|flee)\w*/i,
    /\b(marche|court|grimpe|nage|vole|voyage|arrive|entre|part|s'échappe|fuit)\w*/i,
];

// High-importance narrative keywords
const HIGH_IMPORTANCE_PATTERNS = [
    /\b(kill|die|death|betray|destroy|save|rescue|reveal|secret|transform)\w*/i,
    /\b(tuer|mourir|mort|trahir|détruire|sauver|révéler|secret|transformer)\w*/i,
    /\b(marriage|wedding|pregnant|born|curse|bless|enchant|resurrect|sacrifice)\w*/i,
    /\b(mariage|enceinte|né|malédiction|bénir|enchanter|ressusciter|sacrifice)\w*/i,
    /\b(war|battle|siege|invasion|conquest|rebellion|revolution|treaty|alliance)\w*/i,
    /\b(guerre|bataille|siège|invasion|conquête|rébellion|révolution|traité)\w*/i,
];

// RP formatting indicators (asterisks for actions, quotes for dialogue)
const RP_FORMAT_PATTERNS = [
    /\*[^*]+\*/, // *action text*
    /\".+\"/, // "dialogue"
    /«.+»/, // «french dialogue»
    /\u201C.+\u201D/, // "smart quotes"
];

/**
 * Score a single message's quality for RAG processing.
 */
export function scoreMessageQuality(message: Pick<Message, 'role' | 'content'>): QualityScore {
    const content = message.content.trim();
    const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;

    // Empty or near-empty
    if (wordCount === 0) {
        return { score: 0, label: 'skip', reason: 'Empty message', wordCount, actionDensity: 0 };
    }

    // Check OOC
    for (const pattern of OOC_PATTERNS) {
        if (pattern.test(content)) {
            return { score: 1, label: 'skip', reason: 'OOC content', wordCount, actionDensity: 0 };
        }
    }

    // Check trivial
    for (const pattern of TRIVIAL_PATTERNS) {
        if (pattern.test(content)) {
            return {
                score: 1,
                label: 'skip',
                reason: 'Trivial response',
                wordCount,
                actionDensity: 0,
            };
        }
    }

    // Very short messages with no RP formatting
    if (wordCount < 5) {
        const hasRPFormat = RP_FORMAT_PATTERNS.some((p) => p.test(content));
        if (!hasRPFormat) {
            return {
                score: 2,
                label: 'skip',
                reason: 'Too short, no RP content',
                wordCount,
                actionDensity: 0,
            };
        }
    }

    // Start scoring from base
    let score = 3; // Base: exists and has some content

    // Length bonuses
    if (wordCount >= 15) score += 0.5;
    if (wordCount >= 30) score += 0.5;
    if (wordCount >= 60) score += 0.5;
    if (wordCount >= 120) score += 0.5;
    if (wordCount >= 250) score += 0.5;
    if (wordCount >= 500) score += 0.5;

    // RP formatting bonus
    const rpFormatCount = RP_FORMAT_PATTERNS.filter((p) => p.test(content)).length;
    score += Math.min(rpFormatCount * 0.3, 0.9);

    // Action density: count action matches and normalize by sentence count
    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 3);
    const sentenceCount = Math.max(sentences.length, 1);
    let actionCount = 0;
    for (const pattern of ACTION_PATTERNS) {
        const matches = content.match(new RegExp(pattern.source, 'gi'));
        if (matches) actionCount += matches.length;
    }
    const actionDensity = actionCount / sentenceCount;
    score += Math.min(actionDensity * 0.5, 1.5);

    // High-importance keyword boost
    let highImportanceHits = 0;
    for (const pattern of HIGH_IMPORTANCE_PATTERNS) {
        if (pattern.test(content)) highImportanceHits++;
    }
    score += Math.min(highImportanceHits * 0.7, 2.1);

    // Clamp to 0–10
    score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));

    // Determine label
    let label: QualityScore['label'];
    let reason: string;
    if (score <= 2) {
        label = 'skip';
        reason = 'Below quality threshold';
    } else if (score <= 4) {
        label = 'low';
        reason = 'Light content';
    } else if (score <= 6) {
        label = 'medium';
        reason = 'Standard RP exchange';
    } else if (score <= 8) {
        label = 'high';
        reason = 'Dense narrative content';
    } else {
        label = 'critical';
        reason = 'Major story event';
    }

    return { score, label, reason, wordCount, actionDensity };
}

/**
 * Calculate adaptive chunk size based on message quality density.
 * High-density content gets smaller chunks (more frequent summaries).
 * Low-density content gets larger chunks (fewer summaries).
 *
 * Returns a chunk size between 6 and 15 (default is 10).
 */
export function getAdaptiveChunkSize(
    recentMessages: Pick<Message, 'role' | 'content'>[],
    baseChunkSize: number = 10
): number {
    if (recentMessages.length < 3) return baseChunkSize;

    // Score the recent messages
    const scores = recentMessages.map((m) => scoreMessageQuality(m));
    const qualityScores = scores.filter((s) => s.score >= 3);

    if (qualityScores.length === 0) return Math.min(baseChunkSize + 5, 15); // Low content → bigger chunk

    const avgScore = qualityScores.reduce((sum, s) => sum + s.score, 0) / qualityScores.length;
    const totalWords = scores.reduce((sum, s) => sum + s.wordCount, 0);
    const avgWords = totalWords / recentMessages.length;

    // High average score + high word count → smaller chunk (more detail needed)
    // Low average score + low word count → bigger chunk (less detail needed)
    let chunkSize = baseChunkSize;

    if (avgScore >= 7 && avgWords >= 100) {
        chunkSize = 6; // Critical content: summarize more often
    } else if (avgScore >= 6 && avgWords >= 60) {
        chunkSize = 8; // High content density
    } else if (avgScore <= 4 || avgWords <= 20) {
        chunkSize = 13; // Light content: summarize less often
    } else if (avgScore <= 3) {
        chunkSize = 15; // Very light: maximum chunk size
    }

    return chunkSize;
}
