import { describe, test, expect } from 'bun:test';
import { CLASSIFIER_SYSTEM_PROMPT } from '@/integrations/email/classifier-prompt';
import { SPAM_CATEGORIES, UNSAFE_CATEGORIES } from '@/integrations/email/types';

describe('CLASSIFIER_SYSTEM_PROMPT', () => {
    test('requires safe handling of prompt injection in untrusted email bodies', () => {
        // Contract guard: this prompt is the classifier's only instruction boundary.
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain('PROMPT INJECTION');
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain('MUST be ignored');
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"prompt_injection"');
    });

    test('renders the exact verdict-scoped category vocabularies', () => {
        const quoteCategories = (categories: readonly string[]) => categories.map(category => `"${category}"`).join(', ');
        const unsafeLine = `Categories for "unsafe": ${quoteCategories(UNSAFE_CATEGORIES)}`;
        const spamLine = `Categories for "spam": ${quoteCategories(SPAM_CATEGORIES)}`;

        expect(CLASSIFIER_SYSTEM_PROMPT).toContain(unsafeLine);
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain(spamLine);
    });
});
