import { describe, expect, it } from 'bun:test';
import { FakeResumeStore } from '../../helpers/fake-resume-store';

describe('FakeResumeStore', () => {
    it('load() resolves undefined for a role nothing was ever saved for', async () => {
        const store = new FakeResumeStore();

        await expect(store.load('conversation')).resolves.toBeUndefined();
    });

    it('save() then load() resolves the saved id for that role', async () => {
        const store = new FakeResumeStore();

        await store.save('conversation', 'sess-1');

        await expect(store.load('conversation')).resolves.toBe('sess-1');
    });

    it('a later save() for the same role overwrites the earlier id', async () => {
        const store = new FakeResumeStore();
        await store.save('conversation', 'sess-1');

        await store.save('conversation', 'sess-2');

        await expect(store.load('conversation')).resolves.toBe('sess-2');
    });

    it('conversation and perch roles are stored independently', async () => {
        const store = new FakeResumeStore();

        await store.save('conversation', 'sess-conv');
        await store.save('perch', 'sess-perch');

        await expect(store.load('conversation')).resolves.toBe('sess-conv');
        await expect(store.load('perch')).resolves.toBe('sess-perch');
    });

    it('scriptSaveRejection() makes the next save() reject and leaves the store unchanged', async () => {
        const store = new FakeResumeStore();
        const failure = new Error('DynamoDB throttled');
        store.scriptSaveRejection(failure);

        await expect(store.save('conversation', 'sess-1')).rejects.toBe(failure);

        await expect(store.load('conversation')).resolves.toBeUndefined();
    });

    it('scriptSaveRejection(undefined) clears a scripted rejection so save() succeeds again', async () => {
        const store = new FakeResumeStore();
        store.scriptSaveRejection(new Error('down'));
        store.scriptSaveRejection(undefined);

        await store.save('conversation', 'sess-1');

        await expect(store.load('conversation')).resolves.toBe('sess-1');
    });
});
