import { describe, it, expect } from 'vitest';
import { htmlToPlainText } from '@/lib/html-text';

describe('htmlToPlainText', () => {
    it('passes plain text through untouched (fast path)', () => {
        expect(htmlToPlainText('Une simple description.')).toBe('Une simple description.');
    });

    it('drops style/script blocks entirely (their source must not leak)', () => {
        const html =
            '<style>body::before{content:"";background:#0d0514;}</style><div>Votre fille goth.</div><script>alert(1)</script>';
        const out = htmlToPlainText(html);
        expect(out).toBe('Votre fille goth.');
        expect(out).not.toContain('background');
        expect(out).not.toContain('alert');
    });

    it('strips tags and comments while keeping line structure', () => {
        const html =
            '<!-- FULL WIDTH WRAPPER --><div style="max-width:100%">Ligne 1<br>Ligne 2</div><p>Paragraphe</p>';
        const out = htmlToPlainText(html);
        expect(out).toBe('Ligne 1\nLigne 2\nParagraphe');
        expect(out).not.toContain('max-width');
    });

    it('decodes numeric and named entities (accents, apostrophes)', () => {
        expect(htmlToPlainText('C&#39;est l&#x27;&eacute;t&eacute; &agrave; No&euml;l&hellip;')).toBe(
            "C'est l'été à Noël…"
        );
        expect(htmlToPlainText('&laquo;&nbsp;Bonjour&nbsp;&raquo; &amp; bienvenue')).toBe(
            '« Bonjour » & bienvenue'
        );
    });

    it('renders list items with bullets', () => {
        expect(htmlToPlainText('<ul><li>Un</li><li>Deux</li></ul>')).toBe('• Un\n• Deux');
    });

    it('collapses excessive blank lines left by stripped markup', () => {
        const out = htmlToPlainText('<div>A</div><div></div><div></div><div>B</div>');
        expect(out).toBe('A\n\nB');
    });
});
