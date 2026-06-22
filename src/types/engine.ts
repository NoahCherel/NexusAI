// RP Engine — the behavioral/writing layer of a roleplay turn.
//
// This is deliberately SEPARATE from the API preset (sampling + prompt structure):
// an engine is chosen independently of the sampling profile, so any engine can be
// combined with any preset. The engine's rules are injected into the SYSTEM section
// (before history); a short, NexusAI-native checklist is injected after history.

export type RegisterPolicy = 'faithful' | 'softened';

export interface RPEngine {
    id: string;
    name: string;
    description?: string;

    // Stable identity for built-in engines (so the UI can reference them without
    // depending on array order). Built-ins live as code constants, not persisted state.
    builtinKey?: string;

    // Marks richer/heavier engines that aren't the recommended default.
    experimental?: boolean;

    // The behavioral writing rules, injected into the system section before history.
    // May contain {{user}} — resolved at build time to the active persona name.
    systemBlock: string;

    // How explicit content is handled.
    //  - 'faithful'  : reproduce the explicitness already established in the scene,
    //                  without sanitising it AND without introducing crudeness into a
    //                  scene that is not already explicit.
    //  - 'softened'  : keep content tasteful; fade to black on explicit material.
    registerPolicy: RegisterPolicy;

    // When true, the post-history block adds an advisory nudge to vary how replies open.
    openingVariety: boolean;

    // Static anti-cliché list (English) injected into the system section.
    banList: string[];

    // Only set on user-created/edited engines (persisted in the settings store).
    custom?: boolean;
    createdAt?: Date;
}
