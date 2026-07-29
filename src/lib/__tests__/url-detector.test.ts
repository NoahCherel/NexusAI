import { describe, it, expect } from 'vitest';
import { detectImportUrl } from '@/lib/import/url-detector';

describe('detectImportUrl', () => {
    it('detects JannyAI character URLs (uuid + slug)', () => {
        const r = detectImportUrl(
            'https://jannyai.com/characters/aa11bb22-cc33-4d44-8e55-ff6677889900_character-megumin-arch-wizard'
        );
        expect(r).toEqual({
            platform: 'jannyai',
            id: 'aa11bb22-cc33-4d44-8e55-ff6677889900',
            label: 'JannyAI',
        });
    });

    it('detects Chub and CharacterHub URLs (creator/project)', () => {
        for (const host of ['chub.ai', 'www.chub.ai', 'characterhub.org']) {
            const r = detectImportUrl(`https://${host}/characters/some-creator/my-card-16k`);
            expect(r?.platform).toBe('chub');
            expect(r?.id).toBe('some-creator/my-card-16k');
        }
    });

    it('detects Pygmalion URLs', () => {
        const r = detectImportUrl(
            'https://pygmalion.chat/character/aa11bb22-cc33-4d44-8e55-ff6677889900'
        );
        expect(r?.platform).toBe('pygmalion');
        expect(r?.id).toBe('aa11bb22-cc33-4d44-8e55-ff6677889900');
    });

    it('detects RisuAI Realm URLs', () => {
        const r = detectImportUrl(
            'https://realm.risuai.net/character/aa11bb22-cc33-4d44-8e55-ff6677889900'
        );
        expect(r?.platform).toBe('risuai');
        expect(r?.id).toBe('aa11bb22-cc33-4d44-8e55-ff6677889900');
    });

    it('detects AICharacterCards URLs (last two path segments)', () => {
        const r = detectImportUrl(
            'https://aicharactercards.com/character-cards/fantasy/some-author/great-card/'
        );
        expect(r?.platform).toBe('aicharactercards');
        expect(r?.id).toBe('some-author/great-card');
    });

    it('rejects unknown hosts, malformed URLs and incomplete paths', () => {
        expect(detectImportUrl('https://janitorai.com/characters/abc')).toBeNull();
        expect(detectImportUrl('not a url')).toBeNull();
        expect(detectImportUrl('https://chub.ai/lorebooks/x')).toBeNull();
        expect(detectImportUrl('https://jannyai.com/characters/no-uuid-here')).toBeNull();
    });
});
