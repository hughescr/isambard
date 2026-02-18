import { describe, test, expect } from 'bun:test';
import _ from 'lodash';
import type { APIButtonComponentWithCustomId } from 'discord.js';
import { buildReviewEmbed, buildUnsafeAlert } from '@/integrations/email/review-embed-builder';
import type { EmailMetadata, ClassifierVerdict } from '@/integrations/email/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEmail(overrides: Partial<EmailMetadata> = {}): EmailMetadata {
    return {
        uid:            42,
        messageId:      '<test@example.com>',
        from:           { name: 'Alice Sender', address: 'alice@example.com' },
        to:             [{ address: 'me@rungie.com' }],
        cc:             [],
        subject:        'Hello there',
        date:           new Date('2025-01-15T10:00:00Z'),
        bodyText:       'This is a test email body.',
        hasAttachments: false,
        headers:        {},
        ...overrides,
    };
}

function makeVerdict(overrides: Partial<ClassifierVerdict> = {}): ClassifierVerdict {
    return {
        verdict:    'unsafe',
        confidence: 0.95,
        reason:     'Contains phishing link',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// buildReviewEmbed
// ---------------------------------------------------------------------------

describe('buildReviewEmbed', () => {
    test('creates embed with orange color', () => {
        const email  = makeEmail();
        const result = buildReviewEmbed(email, 'Review');
        const data   = result.embed.toJSON();

        expect(data.color).toBe(0xFF8C00);
    });

    test('sets title to "Email Review Required"', () => {
        const email  = makeEmail();
        const result = buildReviewEmbed(email, 'Review');
        const data   = result.embed.toJSON();

        expect(data.title).toBe('Email Review Required');
    });

    test('includes From field with name and address', () => {
        const email  = makeEmail({ from: { name: 'Alice Sender', address: 'alice@example.com' } });
        const result = buildReviewEmbed(email, 'Review');
        const data   = result.embed.toJSON();

        const fromField = _.find(data.fields, { name: 'From' });
        expect(fromField?.value).toBe('Alice Sender <alice@example.com>');
        expect(fromField?.inline).toBe(true);
    });

    test('includes Subject field', () => {
        const email  = makeEmail({ subject: 'Hello there' });
        const result = buildReviewEmbed(email, 'Review');
        const data   = result.embed.toJSON();

        const subjectField = _.find(data.fields, { name: 'Subject' });
        expect(subjectField?.value).toBe('Hello there');
        expect(subjectField?.inline).toBe(true);
    });

    test('includes Date field as ISO string', () => {
        const date   = new Date('2025-01-15T10:00:00Z');
        const email  = makeEmail({ date });
        const result = buildReviewEmbed(email, 'Review');
        const data   = result.embed.toJSON();

        const dateField = _.find(data.fields, { name: 'Date' });
        expect(dateField?.value).toBe('2025-01-15T10:00:00.000Z');
        expect(dateField?.inline).toBe(true);
    });

    test('uses "(no subject)" when subject is empty', () => {
        const email  = makeEmail({ subject: '' });
        const result = buildReviewEmbed(email, 'Review');
        const data   = result.embed.toJSON();

        const subjectField = _.find(data.fields, { name: 'Subject' });
        expect(subjectField?.value).toBe('(no subject)');
    });

    test('handles missing from name (address only)', () => {
        const email  = makeEmail({ from: { address: 'alice@example.com' } });
        const result = buildReviewEmbed(email, 'Review');
        const data   = result.embed.toJSON();

        const fromField = _.find(data.fields, { name: 'From' });
        expect(fromField?.value).toBe('alice@example.com');
    });

    test('truncates long body text to 500 characters in description', () => {
        const longBody = _.repeat('A', 600);
        const email    = makeEmail({ bodyText: longBody });
        const result   = buildReviewEmbed(email, 'Review');
        const data     = result.embed.toJSON();

        // lodash truncate at 500 adds '...' so total is 500 chars
        expect(data.description?.length).toBe(500);
        expect(data.description).toEndWith('...');
    });

    test('does not truncate body text under 500 characters', () => {
        const shortBody = 'Short body text.';
        const email     = makeEmail({ bodyText: shortBody });
        const result    = buildReviewEmbed(email, 'Review');
        const data      = result.embed.toJSON();

        expect(data.description).toBe(shortBody);
    });

    test('creates 4 buttons with correct customIds using Review folder', () => {
        const email  = makeEmail({ uid: 42 });
        const result = buildReviewEmbed(email, 'Review');

        const buttons = result.actionRow.components;
        expect(buttons).toHaveLength(4);

        const ids = _.map(buttons, b => (b.toJSON() as APIButtonComponentWithCustomId).custom_id);
        expect(ids[0]).toBe('email-trash:42:Review');
        expect(ids[1]).toBe('email-junk:42:Review');
        expect(ids[2]).toBe('email-allow:42:Review');
        expect(ids[3]).toBe('email-allowlist:42:Review');
    });

    test('creates 4 buttons with correct customIds using Quarantine folder', () => {
        const email  = makeEmail({ uid: 42 });
        const result = buildReviewEmbed(email, 'Quarantine');

        const buttons = result.actionRow.components;
        expect(buttons).toHaveLength(4);

        const ids = _.map(buttons, b => (b.toJSON() as APIButtonComponentWithCustomId).custom_id);
        expect(ids[0]).toBe('email-trash:42:Quarantine');
        expect(ids[1]).toBe('email-junk:42:Quarantine');
        expect(ids[2]).toBe('email-allow:42:Quarantine');
        expect(ids[3]).toBe('email-allowlist:42:Quarantine');
    });

    test('buttons have correct labels', () => {
        const email  = makeEmail();
        const result = buildReviewEmbed(email, 'Review');

        const buttons = result.actionRow.components;
        const labels  = _.map(buttons, b => (b.toJSON() as APIButtonComponentWithCustomId).label);
        expect(labels[0]).toBe('Trash');
        expect(labels[1]).toBe('Junk');
        expect(labels[2]).toBe('Allow');
        expect(labels[3]).toBe('Allow + Allowlist');
    });
});

// ---------------------------------------------------------------------------
// buildUnsafeAlert
// ---------------------------------------------------------------------------

describe('buildUnsafeAlert', () => {
    test('creates embed with red color', () => {
        const email   = makeEmail();
        const verdict = makeVerdict();
        const result  = buildUnsafeAlert(email, verdict, 'Quarantine');
        const data    = result.embed.toJSON();

        expect(data.color).toBe(0xFF0000);
    });

    test('sets title to "Unsafe Email Detected"', () => {
        const email   = makeEmail();
        const verdict = makeVerdict();
        const result  = buildUnsafeAlert(email, verdict, 'Quarantine');
        const data    = result.embed.toJSON();

        expect(data.title).toBe('Unsafe Email Detected');
    });

    test('includes From, Subject, Date fields', () => {
        const email   = makeEmail();
        const verdict = makeVerdict();
        const result  = buildUnsafeAlert(email, verdict, 'Quarantine');
        const data    = result.embed.toJSON();

        const fieldNames = _.map(data.fields, 'name');
        expect(fieldNames).toContain('From');
        expect(fieldNames).toContain('Subject');
        expect(fieldNames).toContain('Date');
    });

    test('includes verdict reason in description', () => {
        const email   = makeEmail({ bodyText: 'Some body text.' });
        const verdict = makeVerdict({ reason: 'Contains phishing link' });
        const result  = buildUnsafeAlert(email, verdict, 'Quarantine');
        const data    = result.embed.toJSON();

        expect(data.description).toContain('Contains phishing link');
        expect(data.description).toContain('Some body text.');
    });

    test('creates 4 buttons with correct customIds using Quarantine folder', () => {
        const email   = makeEmail({ uid: 99 });
        const verdict = makeVerdict();
        const result  = buildUnsafeAlert(email, verdict, 'Quarantine');

        const buttons = result.actionRow.components;
        expect(buttons).toHaveLength(4);

        const ids = _.map(buttons, b => (b.toJSON() as APIButtonComponentWithCustomId).custom_id);
        expect(ids[0]).toBe('email-trash:99:Quarantine');
        expect(ids[1]).toBe('email-junk:99:Quarantine');
        expect(ids[2]).toBe('email-allow:99:Quarantine');
        expect(ids[3]).toBe('email-allowlist:99:Quarantine');
    });

    test('includes From field with name and address formatted correctly', () => {
        const email   = makeEmail({ from: { name: 'Bad Actor', address: 'bad@evil.com' } });
        const verdict = makeVerdict();
        const result  = buildUnsafeAlert(email, verdict, 'Quarantine');
        const data    = result.embed.toJSON();

        const fromField = _.find(data.fields, { name: 'From' });
        expect(fromField?.value).toBe('Bad Actor <bad@evil.com>');
    });

    test('handles missing from name in unsafe alert', () => {
        const email   = makeEmail({ from: { address: 'badguy@evil.com' } });
        const verdict = makeVerdict();
        const result  = buildUnsafeAlert(email, verdict, 'Quarantine');
        const data    = result.embed.toJSON();

        const fromField = _.find(data.fields, { name: 'From' });
        expect(fromField?.value).toBe('badguy@evil.com');
    });

    test('uses "(no subject)" when subject is empty in unsafe alert', () => {
        const email   = makeEmail({ subject: '' });
        const verdict = makeVerdict();
        const result  = buildUnsafeAlert(email, verdict, 'Quarantine');
        const data    = result.embed.toJSON();

        const subjectField = _.find(data.fields, { name: 'Subject' });
        expect(subjectField?.value).toBe('(no subject)');
    });

    test('truncates long body text to 500 characters in description', () => {
        const longBody = _.repeat('B', 600);
        const email    = makeEmail({ bodyText: longBody });
        const verdict  = makeVerdict({ reason: 'Phish' });
        const result   = buildUnsafeAlert(email, verdict, 'Quarantine');
        const data     = result.embed.toJSON();

        // description = "**Reason:** Phish\n\n" + truncated body (500 chars, ending '...')
        expect(data.description).toContain('Phish');
        expect(data.description).toEndWith('...');
        // The truncated body portion is exactly 500 chars (lodash truncate at 500)
        // The full description is the prefix + 500-char truncated body
        const prefix = '**Reason:** Phish\n\n';
        expect(data.description!.length).toBe(prefix.length + 500);
    });
});
