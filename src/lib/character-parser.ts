// Character Card V2 Parser
// Extracts JSON metadata embedded in PNG files (tEXt chunk with 'chara' keyword)

import type { CharacterCard, CharacterCardV2 } from '@/types';

/**
 * Parse a PNG file to extract Character Card V2 data
 */
export async function parseCharacterCardPNG(file: File): Promise<CharacterCard> {
    const arrayBuffer = await file.arrayBuffer();
    const dataView = new DataView(arrayBuffer);

    // Verify PNG signature
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
        if (dataView.getUint8(i) !== pngSignature[i]) {
            throw new Error('Invalid PNG file');
        }
    }

    // Search for tEXt chunk with 'chara' keyword
    let offset = 8;
    while (offset < dataView.byteLength) {
        const chunkLength = dataView.getUint32(offset);
        const chunkType = String.fromCharCode(
            dataView.getUint8(offset + 4),
            dataView.getUint8(offset + 5),
            dataView.getUint8(offset + 6),
            dataView.getUint8(offset + 7)
        );

        if (chunkType === 'tEXt') {
            // Read the keyword
            const chunkData = new Uint8Array(arrayBuffer, offset + 8, chunkLength);
            const nullIndex = chunkData.indexOf(0);
            const keyword = new TextDecoder().decode(chunkData.slice(0, nullIndex));

            if (keyword === 'chara') {
                // The rest is base64-encoded JSON
                const base64Data = new TextDecoder().decode(chunkData.slice(nullIndex + 1));
                const jsonString = atob(base64Data);
                const parsed = JSON.parse(jsonString);

                return normalizeCharacterCard(parsed);
            }
        }

        // Move to next chunk (length + type + data + CRC)
        offset += 4 + 4 + chunkLength + 4;

        // Check for IEND
        if (chunkType === 'IEND') break;
    }

    throw new Error(
        'No character data found in PNG. Make sure this is a valid Character Card V2 file.'
    );
}

/**
 * Parse a JSON file as a Character Card
 */
export async function parseCharacterCardJSON(file: File): Promise<CharacterCard> {
    const text = await file.text();
    const parsed = JSON.parse(text);
    return normalizeCharacterCard(parsed);
}

/**
 * Normalize different card formats to our internal format
 */
function normalizeCharacterCard(
    data: CharacterCardV2 | CharacterCard | Record<string, unknown>
): CharacterCard {
    // Handle V2 format
    if ('spec' in data && data.spec === 'chara_card_v2') {
        const v2 = data as CharacterCardV2;
        return {
            ...v2.data,
            id: crypto.randomUUID(),
        };
    }

    // Handle V1 or direct format
    const card = data as Record<string, unknown>;

    return {
        id: crypto.randomUUID(),
        name: (card.name as string) || 'Unknown Character',
        description: (card.description as string) || '',
        personality: (card.personality as string) || '',
        scenario: (card.scenario as string) || '',
        first_mes: (card.first_mes as string) || (card.first_message as string) || '',
        mes_example: (card.mes_example as string) || (card.example_dialogue as string) || '',
        system_prompt: (card.system_prompt as string) || '',
        avatar: (card.avatar as string) || '',
        tags: (card.tags as string[]) || [],
        creator: (card.creator as string) || '',
        creator_notes: (card.creator_notes as string) || '',
        character_book: card.character_book as CharacterCard['character_book'],
    };
}

/**
 * Import a character card from a file (PNG or JSON)
 */
export async function importCharacterCard(file: File): Promise<CharacterCard> {
    const extension = file.name.toLowerCase().split('.').pop();

    if (extension === 'png') {
        const card = await parseCharacterCardPNG(file);
        // Store the avatar as a data URL
        const avatarDataUrl = await fileToDataUrl(file);
        return { ...card, avatar: avatarDataUrl };
    }

    if (extension === 'json') {
        return parseCharacterCardJSON(file);
    }

    throw new Error('Unsupported file format. Please use a PNG or JSON file.');
}

/**
 * Convert a file to a data URL
 */
function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/**
 * Export a character card to JSON
 */
export function exportCharacterCard(card: CharacterCard): string {
    const v2Card: CharacterCardV2 = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: card,
    };
    return JSON.stringify(v2Card, null, 2);
}
