import { describe, test, expect } from 'bun:test';
import { CLASSIFIER_SYSTEM_PROMPT } from '@/integrations/email/classifier-prompt';

describe('CLASSIFIER_SYSTEM_PROMPT', () => {
    test('requires safe handling of prompt injection in untrusted email bodies', () => {
        // Contract guard: this prompt is the classifier's only instruction boundary.
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain('PROMPT INJECTION');
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain('MUST be ignored');
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain('"prompt_injection"');
    });
});
