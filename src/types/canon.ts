// Canon Codex types — immutable, web-sourced ground truth for characters of an
// existing work (anime/book/etc.). The RP layer (rpJournal, world state) is layered
// ON TOP of this and never overwrites it.

/** Canonical relationship of a character toward another, as established in the work. */
export interface CanonRelationship {
    name: string; // the other character
    nature: string; // e.g. "younger sister, devoted", "rival, grudging respect"
}

/**
 * Immutable canonical dossier for one character of a work, scoped to a point in the
 * timeline (`timelineCap`) so it never leaks future-arc spoilers into the fiction.
 * Keyed in storage by `${work}::${character}` (lowercased).
 */
export interface CanonDossier {
    work: string;
    character: string; // canonical name
    timelineCap: string; // e.g. "S2E5", "Chapter 40", "Start" — knowledge capped here
    identity: string; // personality, voice/speech pattern, appearance
    backstory: string; // up to timelineCap
    relationships: CanonRelationship[];
    abilities?: string;
    sources?: string[]; // citation URLs from web retrieval
    fetchedAt: number;
}

/**
 * Full canonical arc outline of a work — Director/GM meta-knowledge, NOT timeline-capped
 * (the GM may foreshadow toward future beats; characters still act capped). Keyed by `work`.
 */
export interface ArcOutline {
    work: string;
    outline: string; // ordered list of arcs / major beats
    sources?: string[];
    fetchedAt: number;
}
