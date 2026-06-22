// Style Guard — a MANUAL, on-demand analysis of the writer's recent output.
//
// Mirrors Megumin's "Analyze Chat": the user clicks a button, the last N assistant replies
// (the active branch only) are audited for repetitive / cliché crutches, and up to 5
// GENERALISED rules come back as revisable suggestions. Nothing is auto-applied: the UI lets
// the user edit, then accept/remove each, before they land on the active branch's ban list
// snapshot (branch-aware; see chat-store `setBanList` / `getActiveBranchBanList`).
//
// Lifecycle is deliberately separate from the post-turn analyzer (Phase 3): this runs only
// when asked, on assistant text only, so it lives in its own module.

import { useSettingsStore } from '@/stores';
import { decryptApiKey } from '@/lib/crypto';
import { backgroundAICall } from '@/lib/ai/background-ai';

/** How many recent assistant replies to audit (Megumin uses 50). */
export const STYLE_SCAN_DEPTH = 50;

/**
 * Identity of a Style Guard analysis run. An analysis is launched against a specific
 * conversation AND a specific active branch tip; a run counter additionally distinguishes
 * otherwise-identical keys (e.g. swiping A→B→A back to the same tip).
 */
export interface AnalysisRunKey {
    runId: number;
    conversationId: string;
    branchTipId: string | null;
}

/**
 * True when an in-flight analysis result must be discarded because the user moved on:
 * a newer run started, the conversation changed, or the active branch tip changed (a swipe
 * keeps the same conversationId but moves the tip). Pure + exported for testing.
 */
export function isAnalysisStale(started: AnalysisRunKey, current: AnalysisRunKey): boolean {
    return (
        started.runId !== current.runId ||
        started.conversationId !== current.conversationId ||
        started.branchTipId !== current.branchTipId
    );
}

/**
 * Parse the model's reply into a clean list of <=5 short rules. Tolerant of code fences,
 * <think> leakage, and prose around the JSON array. Exported for testing.
 */
export function parseRepeatedPhrases(raw: string): string[] {
    const clean = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```json\n?/gi, '')
        .replace(/```\n?/g, '');
    const first = clean.indexOf('[');
    const last = clean.lastIndexOf(']');
    if (first === -1 || last === -1 || last < first) return [];
    try {
        const parsed = JSON.parse(clean.substring(first, last + 1));
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.trim())
            .filter((x) => x.length > 2)
            .slice(0, 5);
    } catch {
        return [];
    }
}

/**
 * Audit recent assistant replies and return up to 5 generalised anti-repetition rules.
 * Returns [] on no input, no OpenRouter key, or model failure (caller handles gracefully).
 */
export async function extractRepeatedPhrases(assistantMessages: string[]): Promise<string[]> {
    const recent = assistantMessages
        .map((m) => m.trim())
        .filter(Boolean)
        .slice(-STYLE_SCAN_DEPTH);
    if (recent.length === 0) return [];

    const { apiKeys, backgroundModel } = useSettingsStore.getState();
    const orKey = apiKeys.find((k) => k.provider === 'openrouter');
    if (!orKey) return [];

    let apiKey: string;
    try {
        apiKey = await decryptApiKey(orKey.encryptedKey);
        if (!apiKey) return [];
    } catch {
        return [];
    }

    const systemPrompt = `You are a prose-repetition auditor for a roleplay writer.
Read the AI replies and find the writer's most overused, repetitive, or cliché habits — crutch phrases, repeated sentence openings, recurring imagery, verbal tics.
Write each finding as ONE short, GENERALISED rule that forbids the underlying habit (not a single quote).
Return ONLY a JSON array of at most 5 lowercase strings, most important first. If nothing stands out, return [].
Example: ["stop opening replies by describing the weather", "avoid 'a shiver ran down their spine' and close variants", "vary sentence openings — too many start with 'she'"]`;

    const userPrompt = `AI replies to audit (oldest first):\n\n${recent.join('\n\n---\n\n')}`;

    const result = await backgroundAICall({
        systemPrompt,
        userPrompt,
        apiKey,
        temperature: 0.2,
        maxTokens: 500,
        backgroundModel,
        disableReasoning: true,
    });
    if (!result) return [];
    return parseRepeatedPhrases(result.content);
}
