import { describe, it, expect } from 'vitest';
import { detectDocumentLanguage } from '@/lib/parsers/language-detector';

describe('Language Detector', () => {
    it.each([
        {
            scenario: 'pure Arabic text',
            text: 'جدول وثيقة تأمين المركبات ضد الغير شركة الصقر للتأمين التعاوني',
            expected: { language: 'ara', hasArabic: true, hasEnglish: false },
        },
        {
            scenario: 'pure English text',
            text: 'Policy schedule Motor Insurance TPL Policy Particulars Policy Number',
            expected: { language: 'eng', hasArabic: false, hasEnglish: true },
        },
        {
            scenario: 'bilingual Arabic and English text',
            text: 'Policy schedule-Motor Insurance TPL جدول وثيقة تأمين المركبات ضد الغير 05/01/2026',
            expected: { language: 'ara+eng', hasArabic: true, hasEnglish: true },
        },
    ])('detects $scenario', ({ text, expected }) => {
        const result = detectDocumentLanguage(text);
        expect(result.language).toBe(expected.language);
        expect(result.hasArabic).toBe(expected.hasArabic);
        expect(result.hasEnglish).toBe(expected.hasEnglish);
    });

    it('detects Arabic presentation forms', () => {
        // Text using presentation forms like \uFE8E, \uFE91
        const text = 'ﺟ ﺪ و ل ﻭ ﺛ ﻴ ﻘ ﺔ';
        const result = detectDocumentLanguage(text);
        expect(result.hasArabic).toBe(true);
    });

    it.each([
        { scenario: 'empty string', text: '' },
        { scenario: 'non-alphabetical string', text: '1234567890 !@#$%^&*()' },
    ])('handles $scenario by falling back to ara+eng', ({ text }) => {
        expect(detectDocumentLanguage(text).language).toBe('ara+eng');
    });
});
