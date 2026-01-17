// Character types for V2 Character Cards
export interface CharacterCard {
    id: string;
    name: string;
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
    NOTION = 'notion'  // concepts, factions, objects, events
}

export interface Lorebook Entry {
    keys: string[];
    content: string;
    enabled: boolean;
    insertion_order ?: number;
    case_sensitive ?: boolean;
    priority ?: number;
    category ?: LorebookCategory;  // Semantic categorization
    position ?: 'before_char' | 'after_char';
}

// V2 Character Card spec (PNG metadata)
export interface CharacterCardV2 {
    spec: 'chara_card_v2';
    spec_version: '2.0';
    data: CharacterCard;
}
