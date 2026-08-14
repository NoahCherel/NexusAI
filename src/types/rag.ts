/**
 * Types for the long-term memory system (the Chronicle).
 *
 * Memory is exclusively hierarchical summaries: Fragments (L0) roll up into Sections (L1),
 * which roll up into Arcs (L2). Atomic facts and vector chunk retrieval used to live here too;
 * both were removed — they duplicated the summaries without being readable or editable, and
 * their overlap was invisible to the model.
 */

// ============================================
// Hierarchical Summaries
// ============================================

export type SummaryLevel = 0 | 1 | 2;

export interface MemorySummary {
    id: string;
    conversationId: string;
    /** 0 = Fragment (~10 msgs), 1 = Section (~50 msgs), 2 = Arc (~150 msgs). */
    level: SummaryLevel;
    /** Message indices covered, 0-based with an EXCLUSIVE end: `[0, 50]` is the first 50. */
    messageRange: [number, number];
    /** The summary text. */
    content: string;
    /** Atomic statements pulled out of the summary. Shown in the panel, never injected. */
    keyFacts: string[];
    /** Child summary IDs (L1 → its L0s, L2 → its L1s). No upward link. */
    childIds: string[];
    createdAt: number;
    /**
     * Rewritten by hand in the memory panel. A full re-index destroys and rebuilds every
     * summary, so it must warn about these before throwing the user's own writing away.
     * Cleared when the summary is regenerated (it is machine-written again).
     */
    isManuallyEdited?: boolean;
    editedAt?: number;
    /**
     * Ordered message IDs of the branch this summary was created on. After a branch switch,
     * summaries of the abandoned branch must not keep narrating it as ground truth.
     * Absent = legacy (always included).
     */
    branchPath?: string[];
}

// ============================================
// Context assembly (preview + dynamic block)
// ============================================

export interface ContextSection {
    priority: number; // 1 = highest
    content: string;
    tokens: number;
    label: string; // For context preview UI
    type: 'system' | 'summary' | 'lorebook' | 'history' | 'post-history' | 'canon';
    confidence?: number; // 0–1 relevance confidence score
    /**
     * These tokens are ALREADY counted inside another section — the system prompt or the
     * post-history block. The section is still shown (the user wants to read it) but must not
     * be added to the total again. The value says where, so the UI can label it.
     *
     * This is a per-section flag rather than a list of excluded types because the same type
     * lands in different places depending on the preset's template: the lorebook is rendered
     * inside the system prompt when the template has `{{lorebook}}`, and in the dynamic zone
     * otherwise.
     */
    countedIn?: 'system' | 'post-history';
}
