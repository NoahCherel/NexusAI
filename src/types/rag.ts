/**
 * Types for the RAG (Retrieval-Augmented Generation) memory system.
 * Supports hierarchical summarization, vector embeddings, and atomic facts.
 */

// ============================================
// Vector Embeddings
// ============================================

export interface VectorEntry {
    id: string;
    conversationId: string;
    messageIds: string[];          // Source message IDs
    text: string;                  // Original text (summary of the chunk)
    embedding: number[];           // Vector (384d for MiniLM)
    metadata: {
        timestamp: number;
        characters: string[];      // NPCs involved
        location: string;          // Place
        importance: number;        // 1-10 (computed by AI or heuristic)
        tags: string[];            // "combat", "dialogue", "discovery", etc.
    };
    branchPath?: string[];         // Ordered message IDs forming the branch lineage
    createdAt: number;
}

// ============================================
// Hierarchical Summaries
// ============================================

export type SummaryLevel = 0 | 1 | 2;

export interface MemorySummary {
    id: string;
    conversationId: string;
    level: SummaryLevel;           // 0 = chunk (10 msgs), 1 = section (50 msgs), 2 = arc
    messageRange: [number, number]; // Message indices covered
    content: string;               // The summary text
    keyFacts: string[];            // Extractable atomic facts
    embedding?: number[];          // For RAG
    childIds: string[];            // Child summary IDs
    createdAt: number;
}

// ============================================
// Atomic Facts (World Events)
// ============================================

export type FactCategory = 'event' | 'relationship' | 'item' | 'location' | 'lore' | 'consequence' | 'dialogue' | string;

export interface WorldFact {
    id: string;
    conversationId: string;
    messageId: string;             // Source message
    fact: string;                  // "The player obtained the Fire Sword from dragon Kael"
    category: FactCategory;
    importance: number;            // 1-10
    active: boolean;               // false if invalidated by a more recent fact
    timestamp: number;
    embedding?: number[];          // For RAG
    relatedEntities: string[];     // ["Fire Sword", "Kael", "Player"]
    lastAccessedAt: number;        // For temporal decay
    accessCount: number;           // Number of times retrieved
    branchPath?: string[];         // Ordered message IDs forming the branch lineage
}

// ============================================
// RAG Query & Results
// ============================================

export interface RAGQuery {
    text: string;
    embedding?: number[];
    conversationId: string;
    topK?: number;
    minScore?: number;
    categoryFilter?: FactCategory[];
}

export interface RAGResult {
    type: 'fact' | 'summary' | 'chunk';
    content: string;
    score: number;                 // Cosine similarity score
    importance: number;
    metadata?: {
        characters?: string[];
        location?: string;
        tags?: string[];
        timestamp?: number;
    };
}

// ============================================
// Context Budget Allocation
// ============================================

export interface ContextBudget {
    systemPrompt: number;          // Token budget for system prompt
    memory: number;                // Token budget for RAG memories
    history: number;               // Token budget for recent messages
    output: number;                // Token budget for output
    total: number;                 // Total token limit
}

export interface ContextSection {
    priority: number;              // 1 = highest
    content: string;
    tokens: number;
    label: string;                 // For context preview UI
    type: 'system' | 'memory' | 'fact' | 'summary' | 'lorebook' | 'history' | 'post-history';
    confidence?: number;           // 0–1 relevance confidence score
}

// ============================================
// Context Preview (for UI)
// ============================================

export interface ContextPreview {
    sections: ContextSection[];
    totalTokens: number;
    maxTokens: number;
    warnings: string[];            // e.g., "Context truncated - 45 messages dropped"
}
