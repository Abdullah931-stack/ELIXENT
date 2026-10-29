// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    isTableExtractionEnabled,
    setTableExtractionEnabled,
} from '@/lib/parsers/pdf-settings';

describe('PDF Settings (pdf-settings.ts)', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it('defaults to true when no preference is set in localStorage', () => {
        expect(isTableExtractionEnabled()).toBe(true);
    });

    it('returns false after table extraction is disabled', () => {
        setTableExtractionEnabled(false);
        expect(isTableExtractionEnabled()).toBe(false);
    });

    it('returns true after table extraction is re-enabled', () => {
        setTableExtractionEnabled(false);
        expect(isTableExtractionEnabled()).toBe(false);

        setTableExtractionEnabled(true);
        expect(isTableExtractionEnabled()).toBe(true);
    });

    it('handles localStorage exceptions defensively without throwing', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('QuotaExceededError or Privacy Mode');
        });

        expect(() => isTableExtractionEnabled()).not.toThrow();
        expect(isTableExtractionEnabled()).toBe(true);

        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError or Privacy Mode');
        });

        expect(() => setTableExtractionEnabled(false)).not.toThrow();
    });
});
