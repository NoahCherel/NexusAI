// Character types for V2 Character Cards
export interface CharacterCard {
    id: string;
    name: string;
    displayName?: string; // For UI demarcation
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    system_prompt?: string;
    avatar?: string;
    tags?: string[];
    creator?: string;
    creator_notes?: string;
    character_book?: Lorebook;
    longTermMemory?: string[];

    // Canon Codex (for "whole-work RPG" cards like NarutoRPG / BLEACH RPG).
    // `work` keys all canon retrieval (auto-derived from the card, user-overridable).
    // `canonCast` is the roster of canonical characters instantiated within this card —
    // their immutable dossiers live in the `canon` store (shared by `work`).
    work?: string;
    canonCast?: string[];
}

export interface Lorebook {
    name?: string;
    description?: string;
    entries: LorebookEntry[];
}

// Lorebook types
export enum LorebookCategory {
    CHARACTER = 'character',
    LOCATION = 'location',
    NOTION = 'notion', // concepts, factions, objects, events
}

export interface LorebookEntry {
    keys: string[];
    content: string;
    enabled: boolean;
    insertion_order?: number;
    case_sensitive?: boolean;
    priority?: number;
    category?: LorebookCategory; // Semantic categorization
    position?: 'before_char' | 'after_char';
}

// V2 Character Card spec (PNG metadata)
export interface CharacterCardV2 {
    spec: 'chara_card_v2';
    spec_version: '2.0';
    data: CharacterCard;
}
