// eslint-disable-next-line import-x/no-extraneous-dependencies -- fixture exercises the installed devDependency patch
import { CheckStatus } from '@stryker-mutator/api/check';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- fixture exercises the installed devDependency patch
import { PlanKind } from '@stryker-mutator/api/core';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- Stryker core owns this runtime dependency
import { from, lastValueFrom, mergeMap, toArray } from 'rxjs';
// eslint-disable-next-line sonarjs/no-internal-api-use -- the regression specifically verifies this patched internal executor
import { MutationTestExecutor } from '../../node_modules/@stryker-mutator/core/dist/src/process/4-mutation-test-executor.js';

async function runScenario(count, failedId) {
    const groupCalls = [];
    const checker = {
        group: (_checkerName, plans) => {
            groupCalls.push(plans.map(({ mutant }) => mutant.id));
            return Promise.resolve([plans]);
        },
        check: (_checkerName, plans) => Promise.resolve(plans.map(plan => [
            plan,
            { status: plan.mutant.id === failedId ? CheckStatus.CompileError : CheckStatus.Passed },
        ])),
    };
    const checkerPool = {
        schedule: (input$, task) => input$.pipe(mergeMap(input => from(Promise.resolve(task(checker, input))))),
    };
    const executor = Object.create(MutationTestExecutor.prototype);
    executor.checkerPool = checkerPool;
    executor.mutationTestReportHelper = {
        reportCheckFailed: mutant => ({ ...mutant, status: 'CompileError' }),
    };
    const plans = Array.from({ length: count }, (_, id) => ({
        plan:       PlanKind.Run,
        mutant:     { id: String(id) },
        runOptions: {},
    }));
    const results = await lastValueFrom(executor.executeSingleChecker('typescript', from(plans)).pipe(toArray()));
    return {
        groupCalls,
        resultIds:      results.map(({ mutant }) => mutant.id),
        earlyResultIds: results.filter(({ plan }) => plan === PlanKind.EarlyResult).map(({ mutant }) => mutant.id),
    };
}

const withPartial = await runScenario(8195, '4096');
const exactMultiple = await runScenario(8192, 'none');
process.stdout.write(JSON.stringify({ withPartial, exactMultiple }));
