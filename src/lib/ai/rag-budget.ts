/**
 * Budget fitting for ranked context blocks.
 *
 * The old behaviour was all-or-nothing: `if (tokens <= remainingBudget) push(block)`. A block
 * overshooting by a single token was thrown away whole — hundreds of granted tokens left empty
 * while genuinely relevant items never reached the model. This fits the block instead, dropping
 * the LEAST relevant items (the tail) until it fits.
 */
import { countTokens, truncateToTokenBudget } from '@/lib/tokenizer';

export interface FittedBlock<T> {
    /** The rendered block, header included. Guaranteed to cost at most `budget` tokens. */
    text: string;
    /** Exact `countTokens(text)` — not the sum of the parts (BPE is not additive at joins). */
    tokens: number;
    /** The items that made it in, in their original order. */
    kept: T[];
    /** How many items were left out. */
    dropped: number;
}

export interface FitRankedBlockOptions {
    /** Joins the header to the first item and the items to each other. Defaults to `'\n'`. */
    separator?: string;
    /**
     * Allow cutting an item mid-way to use up the leftover room. Right for prose (a truncated
     * scene still reads), wrong for atomic statements (a fact cut mid-sentence misleads).
     */
    truncateLast?: boolean;
    /** Below this many leftover tokens, truncating produces a useless stub. Defaults to 80. */
    minLeftoverToTruncate?: number;
}

/**
 * Fit a list ALREADY SORTED by descending priority into a token budget.
 *
 * Cost: one BPE pass over short lines plus a couple of passes over the assembled block —
 * negligible next to the embedding work the caller has already done.
 *
 * @returns `null` when nothing meaningful fits (the caller should emit no block at all).
 */
export function fitRankedBlock<T>(
    items: T[],
    renderItem: (item: T) => string,
    header: string,
    budget: number,
    opts: FitRankedBlockOptions = {}
): FittedBlock<T> | null {
    const { separator = '\n', truncateLast = false, minLeftoverToTruncate = 80 } = opts;

    if (budget <= 0 || items.length === 0) return null;

    const lines = items.map(renderItem);
    const lineTokens = lines.map(countTokens);
    const separatorTokens = countTokens(separator);
    const headerCost = countTokens(header) + separatorTokens;

    // How many whole items fit, cheapest estimate first.
    let used = headerCost;
    let keep = 0;
    for (let i = 0; i < items.length; i++) {
        const cost = lineTokens[i] + (i > 0 ? separatorTokens : 0);
        if (used + cost > budget) break;
        used += cost;
        keep++;
    }

    // Nothing whole fits. Rather than drop the block entirely, cut the BEST item down —
    // but only for prose, and only if enough room remains to leave something readable.
    if (keep === 0) {
        if (!truncateLast) return null;
        const room = budget - headerCost - 4; // 4 ≈ the " […]" marker
        if (room < minLeftoverToTruncate) return null;
        const { text: cut } = truncateToTokenBudget(lines[0], room);
        if (!cut.trim()) return null;
        return finalize(`${header}${separator}${cut} […]`, [items[0]], items.length - 1, budget);
    }

    let keptItems = items.slice(0, keep);
    let body = lines.slice(0, keep).join(separator);

    // Spend the leftover on a partial next item (prose only).
    if (truncateLast && keep < items.length) {
        const leftover = budget - used - separatorTokens - 4;
        if (leftover >= minLeftoverToTruncate) {
            const { text: cut } = truncateToTokenBudget(lines[keep], leftover);
            if (cut.trim()) {
                body += `${separator}${cut} […]`;
                keptItems = items.slice(0, keep + 1);
            }
        }
    }

    return finalize(
        `${header}${separator}${body}`,
        keptItems,
        items.length - keptItems.length,
        budget,
        (n) => ({
            text: `${header}${separator}${lines.slice(0, n).join(separator)}`,
            kept: items.slice(0, n),
        })
    );
}

/**
 * Enforce the hard `tokens <= budget` guarantee on the assembled text.
 *
 * The per-line estimate can undershoot: BPE merges across a join can cost more than the parts
 * counted apart. `shrink` re-renders with one fewer item until the real count fits.
 */
function finalize<T>(
    text: string,
    kept: T[],
    dropped: number,
    budget: number,
    shrink?: (n: number) => { text: string; kept: T[] }
): FittedBlock<T> | null {
    let currentText = text;
    let currentKept = kept;
    let currentDropped = dropped;
    let tokens = countTokens(currentText);

    while (tokens > budget && currentKept.length > 1 && shrink) {
        const smaller = shrink(currentKept.length - 1);
        currentDropped += currentKept.length - smaller.kept.length;
        currentText = smaller.text;
        currentKept = smaller.kept;
        tokens = countTokens(currentText);
    }

    if (tokens > budget) return null;
    return { text: currentText, tokens, kept: currentKept, dropped: currentDropped };
}
