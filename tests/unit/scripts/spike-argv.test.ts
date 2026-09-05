import { describe, expect, it } from 'bun:test';
import { parseSpikeArgs } from '../../../scripts/spike-argv';

describe('parseSpikeArgs', () => {
    it('defaults to every question and no recording with no args', () => {
        expect(parseSpikeArgs([])).toEqual({
            recording:   false,
            recordDir:   'tests/fixtures/sdk-frames/',
            questionArg: 'q1,q2,q3,q4,q5,q6',
        });
    });

    it('reads the question list when --record is absent (the regression this guards)', () => {
        expect(parseSpikeArgs(['q1'])).toEqual({
            recording:   false,
            recordDir:   'tests/fixtures/sdk-frames/',
            questionArg: 'q1',
        });
        expect(parseSpikeArgs(['q1,q2'])).toEqual({
            recording:   false,
            recordDir:   'tests/fixtures/sdk-frames/',
            questionArg: 'q1,q2',
        });
    });

    it('parses a bare --record after the question list with the default fixtures dir', () => {
        expect(parseSpikeArgs(['q1,q2', '--record'])).toEqual({
            recording:   true,
            recordDir:   'tests/fixtures/sdk-frames/',
            questionArg: 'q1,q2',
        });
    });

    it('parses --record=<dir> with a custom fixtures directory', () => {
        expect(parseSpikeArgs(['q1,q2', '--record=/tmp/my-fixtures'])).toEqual({
            recording:   true,
            recordDir:   '/tmp/my-fixtures',
            questionArg: 'q1,q2',
        });
    });

    it('parses --record (or --record=<dir>) before the question list identically to after it', () => {
        expect(parseSpikeArgs(['--record', 'q1,q2,q3'])).toEqual({
            recording:   true,
            recordDir:   'tests/fixtures/sdk-frames/',
            questionArg: 'q1,q2,q3',
        });
        expect(parseSpikeArgs(['--record=/tmp/my-fixtures', 'q1,q2,q3'])).toEqual({
            recording:   true,
            recordDir:   '/tmp/my-fixtures',
            questionArg: 'q1,q2,q3',
        });
    });

    it('defaults to every question when --record is given with no question list', () => {
        expect(parseSpikeArgs(['--record'])).toEqual({
            recording:   true,
            recordDir:   'tests/fixtures/sdk-frames/',
            questionArg: 'q1,q2,q3,q4,q5,q6',
        });
    });
});
