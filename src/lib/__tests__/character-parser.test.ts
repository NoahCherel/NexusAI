import { describe, expect, it } from 'vitest';
import {
    exportCharacterCard,
    parseCharacterCardJSON,
    parseCharacterCardPNGBuffer,
} from '@/lib/character-parser';

function png(text: string, keyword = 'chara', latin1 = false): ArrayBuffer {
    const bytes = latin1
        ? Uint8Array.from(text, (char) => char.charCodeAt(0))
        : new TextEncoder().encode(text);
    const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
    const data = new TextEncoder().encode(`${keyword}\0${encoded}`);
    const buffer = new ArrayBuffer(8 + 12 + data.length + 12);
    const view = new DataView(buffer);
    const target = new Uint8Array(buffer);
    target.set([137, 80, 78, 71, 13, 10, 26, 10]);
    view.setUint32(8, data.length);
    target.set(new TextEncoder().encode('tEXt'), 12);
    target.set(data, 16);
    target.set(new TextEncoder().encode('IEND'), 8 + 12 + data.length + 4);
    return buffer;
}

const description = `Elle dit "Bonjour", puis “À bientôt” et « l’été ». 日本語 🐉\nChemin C:\\cartes\\étoile ; <3 ; 2 < 3 > 1 ; $& ; &quot;texte&quot;.`;
const card = {
    id: 'test',
    name: 'Éléonore “星”',
    description,
    personality: description,
    scenario: description,
    first_mes: description,
    mes_example: description,
    alternate_greetings: [description],
    character_book: { entries: [{ keys: ['été'], content: description, enabled: true }] },
};

describe('character card text survives import unchanged', () => {
    it.each(['chara', 'ccv3'])(
        'decodes UTF-8 bytes in PNG %s metadata before parsing JSON',
        (keyword) => {
            const imported = parseCharacterCardPNGBuffer(
                png(
                    JSON.stringify({
                        spec: keyword === 'ccv3' ? 'chara_card_v3' : 'chara_card_v2',
                        data: card,
                    }),
                    keyword
                )
            );
            expect(imported).toEqual({ ...card, id: expect.any(String) });
        }
    );

    it('retains compatibility with Latin-1 PNG exporters', () => {
        const legacy = {
            ...card,
            name: 'Élodie',
            description: '"Été" à Noël',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            alternate_greetings: [],
            character_book: undefined,
        };
        expect(
            parseCharacterCardPNGBuffer(png(JSON.stringify(legacy), 'chara', true)).description
        ).toBe(legacy.description);
    });

    it('round-trips quotes, backslashes and non-ASCII characters in JSON exports', async () => {
        const file = { text: async () => exportCharacterCard(card) } as File;
        expect(await parseCharacterCardJSON(file)).toEqual({ ...card, id: expect.any(String) });
    });

    it('rejects unescaped JSON quotes rather than silently altering the description', async () => {
        const file = {
            text: async () => '{"name":"Test","description":"Elle dit "Bonjour""}',
        } as File;
        await expect(parseCharacterCardJSON(file)).rejects.toThrow();
    });

    it('reports truncated PNG data without importing a partial card', () => {
        expect(() => parseCharacterCardPNGBuffer(new ArrayBuffer(3))).toThrow('incomplet');
        const valid = png(JSON.stringify(card));
        expect(() => parseCharacterCardPNGBuffer(valid.slice(0, 24))).toThrow('incomplètes');
    });
});
