import type { CharacterWithMemory } from '@/lib/db';

/**
 * An entry in a character list that has been organized by folder.
 * Either a standalone character (no folder set) or a folder bundling several cards.
 */
export type CharacterGroup =
    | { type: 'character'; key: string; character: CharacterWithMemory }
    | { type: 'folder'; key: string; name: string; members: CharacterWithMemory[] };

export type CharacterSort = 'name' | 'recent';

/** The label shown for a single card in lists (matches CharacterCard rendering). */
function characterLabel(c: CharacterWithMemory): string {
    return (c.displayName || c.name || '').toLowerCase();
}

/** Distinct, trimmed folder names currently in use — for editor autocomplete. */
export function listFolders(characters: CharacterWithMemory[]): string[] {
    const set = new Set<string>();
    for (const c of characters) {
        const f = c.folder?.trim();
        if (f) set.add(f);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Group a (pre-filtered) list of characters by their `folder` field, then sort both the
 * top-level entries and the members inside each folder according to `sort`.
 *
 * - Cards with no folder become standalone `character` entries.
 * - Cards sharing a folder name become a single `folder` entry (even with one member).
 * - `getActivity` supplies a last-activity timestamp per id (used only for `sort: 'recent'`).
 */
export function buildCharacterGroups(
    characters: CharacterWithMemory[],
    opts: { sort?: CharacterSort; getActivity?: (id: string) => number } = {}
): CharacterGroup[] {
    const { sort = 'name', getActivity } = opts;
    const activity = (id: string) => getActivity?.(id) ?? 0;

    const folders = new Map<string, CharacterWithMemory[]>();
    const standalone: CharacterWithMemory[] = [];

    for (const c of characters) {
        const folder = c.folder?.trim();
        if (folder) {
            const arr = folders.get(folder);
            if (arr) arr.push(c);
            else folders.set(folder, [c]);
        } else {
            standalone.push(c);
        }
    }

    const memberCompare = (a: CharacterWithMemory, b: CharacterWithMemory) => {
        if (sort === 'recent') {
            const diff = activity(b.id) - activity(a.id);
            if (diff !== 0) return diff;
        }
        return characterLabel(a).localeCompare(characterLabel(b));
    };

    const groups: CharacterGroup[] = [];

    for (const [name, members] of folders) {
        members.sort(memberCompare);
        groups.push({ type: 'folder', key: `folder:${name}`, name, members });
    }
    for (const c of standalone) {
        groups.push({ type: 'character', key: c.id, character: c });
    }

    // A folder's sort weight = its most-recently-active member; its label = the folder name.
    const groupActivity = (g: CharacterGroup) =>
        g.type === 'folder'
            ? g.members.reduce((max, m) => Math.max(max, activity(m.id)), 0)
            : activity(g.character.id);
    const groupLabel = (g: CharacterGroup) =>
        g.type === 'folder' ? g.name.toLowerCase() : characterLabel(g.character);

    groups.sort((a, b) => {
        if (sort === 'recent') {
            const diff = groupActivity(b) - groupActivity(a);
            if (diff !== 0) return diff;
        }
        return groupLabel(a).localeCompare(groupLabel(b));
    });

    return groups;
}
