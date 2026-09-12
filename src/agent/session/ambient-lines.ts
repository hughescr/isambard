/**
 * The per-turn ambient lines (docs/plans/session-peers-and-quota.md, block 4).
 *
 * Two facts every turn of either session should carry without asking for them:
 *
 * 1. **What the other session is doing** — `Perch: slot "reflection" until 15:00, working on
 *    drafting the note, 1 workflow running`, or `Conversation: idle since 14:02`. Composed from
 *    the OTHER role's ledger: its open turn, that turn's phase (and the LLM-generated phase
 *    digest riding on it), its running tasks, and — for a live perch slot turn — the slot fields
 *    the perch envelope's {@link import('./types').EnvelopeMeta} put on `Ledger.perch`.
 * 2. **Provider capacity** — a provider-keyed JSON block under `Quota:`. Fresh utraque reports
 *    carry explicit lookup, observation, window, reset and balance fields. In SDK-only Anthropic
 *    mode, Anthropic instead comes solely from ledger updates whose last source is an SDK
 *    rate-limit event; a missing event is rendered explicitly as unknown. Ledger windows are
 *    merged PER WINDOW across both sessions by their `quota.at` stamps — see
 *    {@link freshestDatedWindow} — and their per-window age is labelled unknown.
 *
 * Both functions here are PURE: no clock, no I/O, no state. `now` is passed in the same way every
 * envelope builder takes it, and the once-after-boot "shared with Craig's own sessions" note is a
 * caller-owned flag ({@link ComposeAmbientLinesParams.sharedQuotaNote}) rather than a module-level
 * latch — the composition root (`src/app/sessions.ts`) owns that flag per role, so each session
 * sees the note exactly once, on the first turn where a quota line actually renders.
 * `src/utils/time.ts`'s `formatTimeHeader` stays pure and ledger-unaware for the same reason:
 * {@link withAmbientLines} is what joins the two.
 *
 * @module agent/session/ambient-lines
 */
import { DateTime } from 'luxon';
import type { ActivityPhase } from './activity-phase';
import type { Ledger, LedgerQuota, LedgerTask, QuotaWindow, QuotaWindows } from './ledger';
import type {
    AnthropicQuotaSource,
    ProviderBalance,
    ProviderHistory,
    ProviderQuota,
    ProviderReferencePrice,
    ProviderReferencePrices,
    ProviderScopeLabel,
    ProviderSnapshot,
    ProviderStatus,
    ProviderTokenMix
} from './quota-poller';
import type { SessionRole } from './types';

/**
 * How a producer of the per-turn time header asks for one: the optional argument is the same
 * user timezone `formatTimeHeader` itself takes (omitted where the producer has no user, e.g.
 * the boot catch-up envelopes), so a provider is a drop-in for `formatTimeHeader`.
 */
export type TimeHeaderProvider = (userTimezone?: string) => string;

/** Every rendered quota line starts with this; the composition root keys its once-note off it. */
export const QUOTA_LINE_PREFIX = 'Quota: ';

/** Parameters for {@link composeAmbientLines}. */
export interface ComposeAmbientLinesParams {
    /** The ledger of the session the header is being built for. */
    self:                  Ledger
    /** The other role's ledger, when this process has one (perch is optional). */
    other?:                Ledger
    /** Stamped by the caller from its own {@link import('./types').Clock}; never read here. */
    now:                   Date
    /** IANA zone every rendered wall-clock stamp is expressed in. */
    timezone:              string
    /** True to append the shared-subscription note to the quota line — see the module doc. */
    sharedQuotaNote?:      boolean
    /** Latest independently-fresh utraque provider report, when the report route is available. */
    providerSnapshot?:     ProviderSnapshot
    /** Which Anthropic quota path this composition intentionally treats as authoritative. */
    anthropicQuotaSource?: AnthropicQuotaSource
}

/** The label each role is announced under in the other-session line. */
const ROLE_LABEL: Record<SessionRole, string> = { conversation: 'Conversation', perch: 'Perch' };

/**
 * A wall-clock stamp in `timezone`: bare `HH:mm` for a time on the same local day as `now`,
 * prefixed with the weekday (`Thu 09:00`) otherwise — so a weekly quota reset days out reads
 * unambiguously while today's five-hour reset stays terse.
 */
function formatStamp(when: Date, now: Date, timezone: string): string {
    const at = DateTime.fromJSDate(when).setZone(timezone);
    const today = DateTime.fromJSDate(now).setZone(timezone);
    return at.hasSame(today, 'day') ? at.toFormat('HH:mm') : at.toFormat('ccc HH:mm');
}

/** The phase digest (`generatedStatus`) when the phase carries one — `compacting` never does. */
function phaseDigest(phase: ActivityPhase | null): string | undefined {
    if(phase === null || !('generatedStatus' in phase)) {
        return undefined;
    }
    return phase.generatedStatus;
}

/** One verb per {@link ActivityPhase} type, for a turn that is not a perch slot turn. */
function phaseVerb(phase: ActivityPhase | null): string {
    if(phase === null) {
        return 'working';
    }
    switch(phase.type) {
        case 'thinking': {
            return 'thinking';
        }
        case 'using_tool': {
            return `using ${phase.toolName}`;
        }
        case 'responding': {
            return 'replying';
        }
        case 'compacting': {
            return 'compacting';
        }
    }
}

/**
 * The leading clause of the other-session line: the perch slot for a live perch slot turn, the
 * phase verb for any other open turn, and `idle since <stamp>` (or a bare `idle`, before this
 * process has ever closed a turn on that session) when nothing is running. `ledger.perch` is
 * sticky — it survives the turn that set it — so the slot is only rendered while a `perch`-kind
 * turn is actually open, never afterwards and never for a Discord turn on the perch session.
 */
function describeActivity(ledger: Ledger, now: Date, timezone: string): string {
    const { turn } = ledger;
    if(turn === null) {
        return ledger.lastTurnEndedAt === undefined
            ? 'idle'
            : `idle since ${formatStamp(ledger.lastTurnEndedAt, now, timezone)}`;
    }
    if(turn.kind === 'perch' && ledger.perch.slot !== undefined) {
        const until = ledger.perch.endsAt === undefined ? '' : ` until ${formatStamp(ledger.perch.endsAt, now, timezone)}`;
        return `slot "${ledger.perch.slot}"${until}`;
    }
    return phaseVerb(turn.phase);
}

/** `n` with `noun` pluralised the English way — the counts here are small and always concrete. */
function plural(n: number, noun: string): string {
    return n === 1 ? `${n} ${noun}` : `${n} ${noun}s`;
}

/** Running-task clauses: workflows counted on their own, everything else lumped as "tasks". */
function taskClauses(tasks: readonly LedgerTask[]): string[] {
    const workflows = tasks.filter(entry => entry.kind === 'workflow').length;
    const others = tasks.length - workflows;
    const clauses: string[] = [];
    if(workflows > 0) {
        clauses.push(`${plural(workflows, 'workflow')} running`);
    }
    if(others > 0) {
        clauses.push(`${plural(others, 'task')} running`);
    }
    return clauses;
}

/** `<Label>: <activity>[, working on <digest>][, <n> workflows running][, <n> tasks running]`. */
function otherSessionLine(other: Ledger, now: Date, timezone: string): string {
    const digest = phaseDigest(other.turn?.phase ?? null);
    const clauses = [
        describeActivity(other, now, timezone),
        ...digest === undefined ? [] : [`working on ${digest}`],
        ...taskClauses(other.tasks),
    ];
    return `${ROLE_LABEL[other.role]}: ${clauses.join(', ')}`;
}

function formatDuration(seconds: number): string {
    if(seconds % 604_800 === 0) {
        return `${seconds / 604_800}w`;
    }
    if(seconds % 86_400 === 0) {
        return `${seconds / 86_400}d`;
    }
    if(seconds % 3600 === 0) {
        return `${seconds / 3600}h`;
    }
    return `${seconds}s`;
}

function iso(when: Date): string {
    return when.toISOString();
}

function roundedComplement(percent: number): number {
    return Number((100 - percent).toFixed(10));
}

function roundedEstimate(value: number): number | undefined {
    return Number.isFinite(value) && value >= 0 ? Number(value.toPrecision(2)) : undefined;
}

function tokenMixData(tokens: ProviderTokenMix): Record<string, number> {
    return {
        input:          tokens.inputTokens,
        output:         tokens.outputTokens,
        cache_creation: tokens.cacheCreationTokens,
        cache_read:     tokens.cacheReadTokens,
        total:          tokens.totalTokens,
    };
}

function usableHistory(provider: ProviderStatus | undefined): ProviderHistory | undefined {
    return provider?.errors.some(error => error.section === 'history') === true ? undefined : provider?.history;
}

function excludedEstimateModel(provider: string, model: string): boolean {
    const normalized = model.toLowerCase();
    return provider === 'codex' && (normalized === 'gpt-5.3-codex-spark' || normalized === 'codex_bengalfox' || normalized === 'gpt-5.5');
}

function blendedPrice(provider: string, price: ProviderReferencePrice, tokens: ProviderTokenMix): number | undefined {
    if(tokens.totalTokens <= 0 || (tokens.cacheReadTokens > 0 && price.cacheRead === undefined)
      || (provider === 'anthropic' && tokens.cacheCreationTokens > 0 && price.cacheWrite === undefined)) {
        return undefined;
    }
    const cacheWrite = provider === 'anthropic' ? (price.cacheWrite ?? 0) : price.input;
    const costPerMillion = tokens.inputTokens * price.input
      + tokens.outputTokens * price.output
      + tokens.cacheReadTokens * (price.cacheRead ?? 0)
      + tokens.cacheCreationTokens * cacheWrite;
    const blended = costPerMillion / tokens.totalTokens;
    return Number.isFinite(blended) && blended > 0 ? blended : undefined;
}

function matchesModelScope(model: string, scope: ProviderScopeLabel | undefined): boolean {
    if(scope === undefined) {
        return true;
    }
    const normalized = model.toLowerCase();
    return scope.id?.toLowerCase() === normalized || scope.displayName?.toLowerCase() === normalized;
}

function cheapestPrice(
    provider: string,
    prices: ProviderReferencePrices,
    tokens: ProviderTokenMix,
    scope?: ProviderScopeLabel
): { model: string, blended: number } | undefined {
    const candidates = prices.models.flatMap((price) => {
        if(!price.eligible || excludedEstimateModel(provider, price.model) || !matchesModelScope(price.model, scope)) {
            return [];
        }
        const blended = blendedPrice(provider, price, tokens);
        return blended === undefined ? [] : [{ model: price.model, blended }];
    });
    candidates.sort((left, right) => left.blended - right.blended || left.model.localeCompare(right.model));
    return candidates[0];
}

function referenceCost(models: readonly ProviderHistory['recentModels'][number][]): number | undefined {
    const usedModels = models.filter(model => model.tokens.totalTokens > 0);
    if(usedModels.length === 0) {
        return undefined;
    }
    let cost = 0;
    for(const model of usedModels) {
        if(model.costUsd === undefined) {
            return undefined;
        }
        cost += model.costUsd;
    }
    return Number.isFinite(cost) && cost > 0 ? cost : undefined;
}

function combinedTokens(models: readonly ProviderHistory['recentModels'][number][]): ProviderTokenMix | undefined {
    const total: ProviderTokenMix = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
    for(const model of models) {
        total.inputTokens += model.tokens.inputTokens;
        total.outputTokens += model.tokens.outputTokens;
        total.cacheCreationTokens += model.tokens.cacheCreationTokens;
        total.cacheReadTokens += model.tokens.cacheReadTokens;
        total.totalTokens += model.tokens.totalTokens;
    }
    return Number.isSafeInteger(total.totalTokens) && total.totalTokens > 0 ? total : undefined;
}

interface EstimateSample {
    basis:  'current_5h_local_ratio' | 'recent_7d_local_ratio'
    tokens: ProviderTokenMix
    cost:   number
    since:  Date
    until:  Date
}

function fiveHourEstimateSample(
    provider: string,
    resetsAt: Date,
    history: ProviderHistory,
    modelScope: ProviderScopeLabel | undefined
): EstimateSample | undefined {
    const block = history.blocks.find(candidate => candidate.active && !candidate.gap && !candidate.mixedProvider
      && candidate.endTime.getTime() - candidate.startTime.getTime() === 5 * 3_600_000
      && candidate.endTime.getTime() === resetsAt.getTime()
      && candidate.modelProviders.length > 0
      && candidate.modelProviders.every(modelProvider => modelProvider === provider)
      && candidate.modelNames.every(model => matchesModelScope(model, modelScope))
      && !candidate.modelNames.some(model => excludedEstimateModel(provider, model)));
    return block?.costUsd === undefined || block.costUsd <= 0
        ? undefined
        : {
            basis:  'current_5h_local_ratio', tokens: block.tokens, cost:   block.costUsd,
            since:  block.startTime, until:  block.endTime,
        };
}

function weeklyEstimateSample(history: ProviderHistory, modelScope: ProviderScopeLabel | undefined): EstimateSample | undefined {
    const models = modelScope === undefined
        ? history.recentModels
        : history.recentModels.filter(model => matchesModelScope(model.model, modelScope));
    const cost = referenceCost(models);
    const tokens = modelScope === undefined ? history.recentTokens : combinedTokens(models);
    return cost === undefined || tokens === undefined
        ? undefined
        : {
            basis: 'recent_7d_local_ratio', tokens, cost,
            since: history.recentSince, until: history.recentUntil,
        };
}

function estimateSample(
    provider: string,
    window: string | undefined,
    resetsAt: Date | undefined,
    history: ProviderHistory,
    modelScope: ProviderScopeLabel | undefined
): EstimateSample | undefined {
    if(window === '1w' && history.recentDays === 7) {
        return weeklyEstimateSample(history, modelScope);
    }
    return window === '5h' && resetsAt !== undefined
        ? fiveHourEstimateSample(provider, resetsAt, history, modelScope)
        : undefined;
}

function quotaEstimateData(
    provider: string,
    window: string | undefined,
    usedPercent: number,
    resetsAt: Date | undefined,
    history: ProviderHistory | undefined,
    prices: ProviderReferencePrices | undefined,
    modelScope?: ProviderScopeLabel
): Record<string, unknown> | undefined {
    if(history === undefined || prices === undefined || usedPercent < 1 || usedPercent > 100) {
        return undefined;
    }
    const sample = estimateSample(provider, window, resetsAt, history, modelScope);
    if(sample === undefined || sample.tokens.totalTokens <= 0) {
        return undefined;
    }
    const cheapest = cheapestPrice(provider, prices, sample.tokens, modelScope);
    if(cheapest === undefined) {
        return undefined;
    }
    const estimate = roundedEstimate(sample.cost * (100 - usedPercent) / usedPercent * 1_000_000 / cheapest.blended);
    if(estimate === undefined) {
        return undefined;
    }
    return {
        estimate_tokens_remaining: estimate,
        estimate_model:            cheapest.model,
        estimate_basis:            sample.basis,
        estimate_sample_tokens:    tokenMixData(sample.tokens),
        estimate_sample_period:    { since: iso(sample.since), until: iso(sample.until) },
    };
}

function historyEstimateData(history: ProviderHistory | undefined): Record<string, unknown> | undefined {
    return history === undefined
        ? undefined
        : {
            source:           history.source,
            coverage:         history.coverage,
            cost_basis:       history.costBasis,
            finished_at:      iso(history.finishedAt),
            recent_7d_tokens: tokenMixData(history.recentTokens),
            recent_7d_period: { since: iso(history.recentSince), until: iso(history.recentUntil) },
        };
}

function referencePriceData(prices: ProviderReferencePrices | undefined): Record<string, unknown> | undefined {
    return prices === undefined
        ? undefined
        : {
            source:      prices.source,
            observed_at: iso(prices.observedAt),
            stale:       prices.stale ? true : undefined,
            unit:        prices.unit,
            assumptions: prices.assumptions.length === 0 ? undefined : prices.assumptions,
        };
}

function deepSeekRemainingData(
    provider: ProviderStatus,
    history: ProviderHistory | undefined,
    quotaFresh: boolean
): readonly Record<string, unknown>[] {
    const prices = provider.prices;
    const observation = provider.quotaAfter;
    if(provider.provider !== 'deepseek' || history === undefined || prices === undefined || !quotaFresh
      || observation === undefined || observation.available === false || provider.errors.some(error => error.section === 'balances')
      || observation.spendControls.some(control => control.reached)) {
        return [];
    }
    const balance = observation.balances.find(candidate => candidate.currency === 'USD'
      && candidate.scopeId === undefined && candidate.available !== false && candidate.unlimited !== true && candidate.total !== undefined);
    const balanceValue = balance?.total === undefined ? undefined : Number(balance.total);
    if(balance === undefined || balanceValue === undefined || !Number.isFinite(balanceValue) || balanceValue < 0) {
        return [];
    }
    return prices.models.flatMap((price) => {
        const blended = price.eligible && !excludedEstimateModel(provider.provider, price.model)
            ? blendedPrice(provider.provider, price, history.recentTokens)
            : undefined;
        const tokensPerUsd = blended === undefined ? undefined : roundedEstimate(1_000_000 / blended);
        const tokensRemaining = blended === undefined ? undefined : roundedEstimate(balanceValue * 1_000_000 / blended);
        return tokensPerUsd === undefined || tokensRemaining === undefined
            ? []
            : [{
                estimate_model:            price.model,
                currency:                  'USD',
                balance:                   balance.total,
                estimate_tokens_remaining: tokensRemaining,
                estimate_tokens_per_usd:   tokensPerUsd,
                basis:                     'models_dev_observed_mix',
            }];
    });
}

function providerEstimatesData(
    provider: ProviderStatus,
    history: ProviderHistory | undefined,
    quotaFresh = false
): Record<string, unknown> | undefined {
    const historyData = historyEstimateData(history);
    const priceData = referencePriceData(provider.prices);
    const remaining = deepSeekRemainingData(provider, history, quotaFresh);
    return historyData === undefined && priceData === undefined && remaining.length === 0
        ? undefined
        : {
            history:            historyData,
            reference_prices:   priceData,
            remaining_by_model: remaining.length === 0 ? undefined : remaining,
        };
}

function scopeLabel(label: { id?: string, displayName?: string } | undefined): { id?: string, name?: string } | undefined {
    if(label?.id === undefined && label?.displayName === undefined) {
        return undefined;
    }
    return { id: label.id, name: label.displayName };
}

function quotaWindow(quota: ProviderQuota): string | undefined {
    if(quota.durationSeconds !== undefined) {
        return formatDuration(quota.durationSeconds);
    }
    if(quota.kind === 'session' || quota.kind === 'five_hour' || quota.id === 'session' || quota.id === 'five_hour') {
        return '5h';
    }
    if(quota.kind?.startsWith('weekly') || quota.kind?.startsWith('seven_day')
      || quota.id.startsWith('weekly') || quota.id.startsWith('seven_day')) {
        return '1w';
    }
    return undefined;
}

/** Spark was retired from Isambard; hide its dedicated meter without hiding shared Codex quota. */
function isSparkQuota(provider: string, quota: ProviderQuota): boolean {
    return provider === 'codex' && (quota.id === 'codex_bengalfox'
      || quota.name === 'GPT-5.3-Codex-Spark'
      || quota.scope?.model?.id === 'gpt-5.3-codex-spark'
      || quota.scope?.model?.displayName === 'GPT-5.3-Codex-Spark');
}

function needsSlot(quota: ProviderQuota, quotas: readonly ProviderQuota[]): boolean {
    return quotas.some(candidate => candidate.id === quota.id
      && quotaWindow(candidate) === quotaWindow(quota)
      && candidate.slot !== quota.slot);
}

function quotaScope(quota: ProviderQuota, includeSlot: boolean): Record<string, unknown> | undefined {
    const model = scopeLabel(quota.scope?.model);
    const surface = scopeLabel(quota.scope?.surface);
    const slot = includeSlot ? quota.slot : undefined;
    if(quota.group === undefined && model === undefined && surface === undefined && slot === undefined) {
        return undefined;
    }
    return { group: quota.group, model, surface, slot };
}

function quotaIdentity(quota: ProviderQuota): string {
    const model = quota.scope?.model, surface = quota.scope?.surface;
    return JSON.stringify([quota.id, quota.group, quota.slot, quota.durationSeconds, quota.resetsAt?.toISOString(),
        model?.id, model?.displayName, surface?.id, surface?.displayName]);
}

function burnPace(quota: ProviderQuota, currentAt: Date, previous: ProviderStatus | undefined): number | undefined {
    if(quota.resetsAt === undefined) {
        return undefined;
    }
    const priorObservation = previous?.quotaAfter;
    if(priorObservation === undefined) {
        return undefined;
    }
    const prior = priorObservation.quotas.find(candidate => quotaIdentity(candidate) === quotaIdentity(quota));
    if(prior === undefined) {
        return undefined;
    }
    const elapsedHours = (currentAt.getTime() - priorObservation.collectedAt.getTime()) / 3_600_000;
    const increase = quota.usedPercent - prior.usedPercent;
    if(elapsedHours < 1 / 60 || increase <= 0) {
        return undefined;
    }
    const rate = increase / elapsedHours;
    return Number(rate.toFixed(1));
}

function providerQuotaData(
    provider: string,
    quota: ProviderQuota,
    quotas: readonly ProviderQuota[],
    collectedAt: Date,
    previous: ProviderStatus | undefined,
    now: Date,
    history: ProviderHistory | undefined,
    prices: ProviderReferencePrices | undefined
): Record<string, unknown> {
    const window = quotaWindow(quota);
    const scope = quotaScope(quota, needsSlot(quota, quotas));
    const identity = {
        id:   quota.id,
        name: quota.name === quota.id ? undefined : quota.name,
        window,
        scope,
    };
    if(quota.active === false) {
        return { ...identity, status: 'inactive' };
    }
    if(quota.resetsAt !== undefined && quota.resetsAt.getTime() <= now.getTime()) {
        return { ...identity, status: 'expired' };
    }
    const pace = burnPace(quota, collectedAt, previous);
    const groupMatchesWindow = quota.group === undefined
      || (window === '5h' && quota.group === 'session')
      || (window === '1w' && quota.group === 'weekly');
    const estimate = quota.scope?.surface === undefined && groupMatchesWindow
        ? quotaEstimateData(provider, window, quota.usedPercent, quota.resetsAt, history, prices, quota.scope?.model)
        : undefined;
    return {
        ...identity,
        used_percent:                 quota.usedPercent,
        remaining_percent:            roundedComplement(quota.usedPercent),
        resets_at:                    quota.resetsAt === undefined ? undefined : iso(quota.resetsAt),
        shared_burn_percent_per_hour: pace,
        ...estimate,
    };
}

function providerBalanceData(balance: ProviderBalance): Record<string, unknown> {
    const identity = {
        kind:     balance.kind,
        scope_id: balance.scopeId,
    };
    if(balance.unlimited === true) {
        return { ...identity, status: 'unlimited' };
    }
    if(balance.available === false) {
        return { ...identity, status: 'unknown' };
    }
    return {
        ...identity,
        currency:    balance.currency,
        total:       balance.total,
        amount_unit: balance.amountUnit,
        status:      balance.total === undefined ? 'reported' : undefined,
    };
}

function quotaApiError(code: string): string {
    const normalized = code.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
    return normalized === 'http_429'
        ? 'quota_api_rate_limited'
        : `quota_api_${normalized}`;
}

function quotaLookupData(provider: ProviderStatus, reportExpiredAt: Date | undefined, generatedAt: Date, now: Date): Record<string, unknown> {
    const quotaErrors = provider.errors.filter(error => error.section === 'quota_after');
    const elapsed = Math.max(0, (now.getTime() - generatedAt.getTime()) / 1000);
    const base = {
        last_attempt_at:   iso(provider.lastAttempt),
        cached:            provider.freshness.cached ? true : undefined,
        age_seconds:       provider.freshness.cached ? Math.round(provider.freshness.ageSeconds + elapsed) : undefined,
        report_expired_at: reportExpiredAt === undefined ? undefined : iso(reportExpiredAt),
    };
    if(quotaErrors.length === 0) {
        if(provider.freshness.stale || reportExpiredAt !== undefined) {
            return { status: 'unknown', error: 'quota_data_stale', ...base };
        }
        if(provider.quotaAfter === undefined) {
            return { status: 'unknown', error: 'quota_api_no_observation', ...base };
        }
        return provider.quotaAfter.available === false
            ? { status: 'unknown', error: 'quota_api_no_reading', ...base }
            : { status: 'ok', ...base };
    }
    if(quotaErrors.length === 1) {
        const failure = quotaErrors[0]!;
        return {
            status:   'unknown', error:    quotaApiError(failure.code), ...base,
            retry_at: failure.retryAt === undefined ? undefined : iso(failure.retryAt),
        };
    }
    return { status: 'unknown', error: 'quota_api_multiple_errors', ...base, errors: quotaErrors.map(entry => quotaApiError(entry.code)) };
}

function providerData(provider: ProviderStatus, previous: ProviderStatus | undefined, reportExpiredAt: Date | undefined, generatedAt: Date, now: Date): Record<string, unknown> {
    const quotaLookup = quotaLookupData(provider, reportExpiredAt, generatedAt, now);
    const reportErrors = provider.errors.filter(error => error.section !== 'quota_after');
    const history = usableHistory(provider);
    const base = {
        quota_lookup:  quotaLookup,
        report_status: provider.status === 'ok' ? undefined : provider.status,
        errors:        reportErrors.length === 0 ? undefined : reportErrors,
        estimates:     providerEstimatesData(provider, history, quotaLookup.status === 'ok'),
    };
    if(quotaLookup.status !== 'ok') {
        return base;
    }
    // `quotaLookupData` returns `ok` only for a present, available observation.
    const observation = provider.quotaAfter!;
    const excludedScopeIds = new Set<string>();
    if(provider.provider === 'codex') {
        excludedScopeIds.add('codex_bengalfox');
    }
    const quotas = observation.quotas.filter((quota) => {
        if(isSparkQuota(provider.provider, quota)) {
            excludedScopeIds.add(quota.id);
            return false;
        }
        return true;
    });
    const balances = observation.balances.filter(balance => balance.scopeId === undefined || !excludedScopeIds.has(balance.scopeId));
    const spendControls = observation.spendControls.filter(control => !excludedScopeIds.has(control.scopeId));
    const reachedSpendControls = spendControls.filter(control => control.reached);
    return {
        ...base,
        observed_at: iso(observation.collectedAt),
        quotas:      quotas.length === 0
            ? undefined
            : quotas.map(quota => providerQuotaData(
                provider.provider, quota, quotas, observation.collectedAt, previous, now, history, provider.prices
            )),
        balances:       balances.length === 0 ? undefined : balances.map(balance => providerBalanceData(balance)),
        spend_controls: reachedSpendControls.length === 0
            ? undefined
            : reachedSpendControls.map(control => ({ scope_id: control.scopeId, reached: true })),
    };
}

function providerUnavailable(provider: ProviderStatus, reportExpired: boolean): boolean {
    if(provider.freshness.stale || reportExpired || provider.errors.some(error => error.section === 'quota_after')) {
        return true;
    }
    return provider.quotaAfter === undefined || provider.quotaAfter.available === false;
}

function windowData(
    id: string,
    window: QuotaWindow,
    now: Date,
    provider?: string,
    history?: ProviderHistory,
    prices?: ProviderReferencePrices
): Record<string, unknown> {
    const identity = { id, window: id === 'five_hour' ? '5h' : '1w' };
    return window.resetsAt !== undefined && window.resetsAt <= now
        ? { ...identity, status: 'expired' }
        : {
            ...identity,
            used_percent:      window.utilization,
            remaining_percent: roundedComplement(window.utilization),
            resets_at:         window.resetsAt === undefined ? undefined : iso(window.resetsAt),
            ...provider === undefined ? {} : quotaEstimateData(provider, identity.window, window.utilization, window.resetsAt, history, prices),
        };
}

function directFallbackData(windows: QuotaWindows, collectedAt: Date, now: Date): Record<string, unknown> {
    const quotas = [
        ...windows.fiveHour === undefined ? [] : [windowData('five_hour', windows.fiveHour, now)],
        ...windows.sevenDay === undefined ? [] : [windowData('seven_day', windows.sevenDay, now)],
    ];
    if(quotas.length === 0) {
        return { quota_lookup: { status: 'unknown', error: 'quota_api_no_reading', last_attempt_at: iso(collectedAt), source: 'direct_anthropic' } };
    }
    return {
        quota_lookup: { status: 'ok', last_attempt_at: iso(collectedAt), source: 'direct_anthropic' },
        observed_at:  iso(collectedAt),
        quotas,
    };
}

function quotaBlock(data: Record<string, unknown>): string {
    return `${QUOTA_LINE_PREFIX}\n\`\`\`json\n${JSON.stringify(data, undefined, 2)}\n\`\`\``;
}

function sdkProviderLine(
    snapshot: ProviderSnapshot,
    selfQuota: LedgerQuota | undefined,
    otherQuota: LedgerQuota | undefined,
    now: Date,
    sharedNote: boolean
): string {
    const reportExpiredAt = snapshot.expiresAt !== undefined && snapshot.expiresAt <= now ? snapshot.expiresAt : undefined;
    const entries = snapshot.providers.filter(provider => provider.provider !== 'anthropic').map(provider => [
        provider.provider,
        providerData(
            provider,
            snapshot.previous?.providers.find(previous => previous.provider === provider.provider),
            reportExpiredAt,
            snapshot.generatedAt,
            now
        ),
    ] as const);
    const data: Record<string, unknown> = Object.fromEntries(entries);
    const anthropic = snapshot.providers.find(provider => provider.provider === 'anthropic');
    const history = usableHistory(anthropic);
    const ledger = sdkLedgerFallbackData(selfQuota, otherQuota, now, history, anthropic?.prices);
    data.anthropic = {
        ...(ledger ?? { quota_values: { status: 'unknown', reason: 'no_sdk_quota_reading' } }),
        estimates: anthropic === undefined ? undefined : providerEstimatesData(anthropic, history),
    };
    data.note = sharedNote ? 'Subscription quotas are shared; provider balances are separate.' : undefined;
    return quotaBlock(data);
}

function providerLine(
    snapshot: ProviderSnapshot,
    selfQuota: LedgerQuota | undefined,
    otherQuota: LedgerQuota | undefined,
    now: Date,
    _timezone: string,
    sharedNote: boolean,
    anthropicQuotaSource: AnthropicQuotaSource
): string {
    if(anthropicQuotaSource === 'sdk') {
        return sdkProviderLine(snapshot, selfQuota, otherQuota, now, sharedNote);
    }
    const reportExpiredAt = snapshot.expiresAt !== undefined && snapshot.expiresAt <= now ? snapshot.expiresAt : undefined;
    const fallback = snapshot.anthropicFallback === undefined || snapshot.anthropicFallback.expiresAt <= now
        ? undefined
        : directFallbackData(snapshot.anthropicFallback.windows, snapshot.anthropicFallback.collectedAt, now);
    const anthropicReport = snapshot.providers.find(provider => provider.provider === 'anthropic');
    const anthropicHistory = usableHistory(anthropicReport);
    const sdkFallback = sdkLedgerFallbackData(selfQuota, otherQuota, now, anthropicHistory, anthropicReport?.prices);
    const entries = snapshot.providers.map((provider) => {
        const unavailableAnthropic = provider.provider === 'anthropic' && providerUnavailable(provider, reportExpiredAt !== undefined);
        if(unavailableAnthropic && fallback !== undefined) {
            return [provider.provider, fallback] as const;
        }
        const data = providerData(
            provider,
            snapshot.previous?.providers.find(previous => previous.provider === provider.provider),
            reportExpiredAt,
            snapshot.generatedAt,
            now
        );
        return [provider.provider, unavailableAnthropic && sdkFallback !== undefined
            ? { ...data, quota_values: sdkFallback.quota_values, quotas: sdkFallback.quotas }
            : data] as const;
    });
    const data: Record<string, unknown> = Object.fromEntries(entries);
    const anthropicFallback = fallback ?? sdkFallback;
    if(!Object.hasOwn(data, 'anthropic') && anthropicFallback !== undefined) {
        data.anthropic = anthropicFallback;
    }
    if(Object.keys(data).length === 0) {
        data.anthropic = { quota_lookup: { status: 'unknown', error: 'quota_api_no_reading', last_attempt_at: iso(snapshot.generatedAt) } };
    }
    data.note = sharedNote ? 'Subscription quotas are shared; provider balances are separate.' : undefined;
    return quotaBlock(data);
}

/** The two unified windows either session paces itself against; per-model windows are not rendered. */
type UnifiedWindowName = 'fiveHour' | 'sevenDay';

/** One ledger's reading of one window, carrying the `quota.at` stamp that dates it. */
interface DatedWindow {
    window: QuotaWindow
    at:     Date
    source: LedgerQuota['source']
}

/** `quota`'s reading of `name`, dated by `quota.at`, or undefined when that ledger knows no such window. */
function datedWindow(quota: LedgerQuota | undefined, name: UnifiedWindowName): DatedWindow | undefined {
    if(quota === undefined) {
        return undefined;
    }
    const window = quota[name];
    return window === undefined ? undefined : { window, at: quota.at, source: quota.source };
}

/**
 * The freshest known reading of ONE unified window across both ledgers.
 *
 * The subscription is one account, so either ledger describes the same windows — but they are
 * refreshed independently: a `rate_limit_event` frame folds only into the emitting role's ledger,
 * emission is change-driven rather than per-turn, and the usage poller (the only path that writes
 * both at once) targets an endpoint whose shape is UNVERIFIED. So neither ledger is reliably the
 * fresher one, and a ledger can legitimately know a window the other does not (a frame with no
 * `unifiedWindows` files only the window that tripped the emit). Per window, then: the reading
 * stamped with the later `quota.at` wins, a ledger carrying no such window never wins, and a tie
 * goes to `self` — the session actually about to spend.
 */
/**
 * The quota line, or undefined when neither unified window is known — a `quota` carrying only
 * per-model weekly windows renders nothing, since those are not what either session is pacing
 * itself against.
 */
function freshestDatedWindow(name: UnifiedWindowName, self: LedgerQuota | undefined, other: LedgerQuota | undefined): DatedWindow | undefined {
    const mine = datedWindow(self, name);
    const theirs = datedWindow(other, name);
    if(mine === undefined) {
        return theirs;
    }
    if(theirs === undefined) {
        return mine;
    }
    return theirs.at.getTime() > mine.at.getTime() ? theirs : mine;
}

function ledgerFallbackData(
    self: LedgerQuota | undefined,
    other: LedgerQuota | undefined,
    now: Date,
    provider?: string,
    history?: ProviderHistory,
    prices?: ProviderReferencePrices
): Record<string, unknown> | undefined {
    const fiveHour = freshestDatedWindow('fiveHour', self, other);
    const sevenDay = freshestDatedWindow('sevenDay', self, other);
    const quotas = [
        ...fiveHour === undefined ? [] : [windowData('five_hour', fiveHour.window, now, provider, history, prices)],
        ...sevenDay === undefined ? [] : [windowData('seven_day', sevenDay.window, now, provider, history, prices)],
    ];
    if(quotas.length === 0) {
        return undefined;
    }
    const sources = new Set([fiveHour?.source, sevenDay?.source]);
    sources.delete(undefined);
    let lastUpdateSource = 'mixed';
    if(sources.size === 1) {
        lastUpdateSource = sources.has('headers') ? 'sdk_rate_limit_event' : 'quota_poller';
    }
    return {
        quota_lookup: { status: 'unknown', error: 'quota_api_not_checked' },
        quota_values: { source: 'session_ledger', last_update_source: lastUpdateSource, age: 'unknown' },
        quotas,
    };
}

function sdkLedgerFallbackData(
    self: LedgerQuota | undefined,
    other: LedgerQuota | undefined,
    now: Date,
    history?: ProviderHistory,
    prices?: ProviderReferencePrices
): Record<string, unknown> | undefined {
    const fallback = ledgerFallbackData(
        self?.source === 'headers' ? self : undefined,
        other?.source === 'headers' ? other : undefined,
        now,
        'anthropic',
        history,
        prices
    );
    return fallback === undefined
        ? undefined
        : {
            quota_values: { status: 'ok', source: 'session_ledger', last_update_source: 'sdk_rate_limit_event', age: 'unknown' },
            quotas:       fallback.quotas,
        };
}

function quotaLine(
    self: LedgerQuota | undefined,
    other: LedgerQuota | undefined,
    now: Date,
    _timezone: string,
    sharedNote: boolean,
    anthropicQuotaSource: AnthropicQuotaSource
): string | undefined {
    if(anthropicQuotaSource === 'sdk') {
        return quotaBlock({
            anthropic: sdkLedgerFallbackData(self, other, now) ?? { quota_values: { status: 'unknown', reason: 'no_sdk_quota_reading' } },
            note:      sharedNote ? 'Anthropic quota is shared with Craig\'s own sessions.' : undefined,
        });
    }
    const fallback = ledgerFallbackData(self, other, now);
    if(fallback === undefined) {
        return undefined;
    }
    return quotaBlock({
        anthropic: fallback,
        note:      sharedNote ? 'Anthropic quota is shared with Craig\'s own sessions.' : undefined,
    });
}

/**
 * Composes the ambient lines for one session's next turn — at most one other-session line and
 * at most one quota line, in that order. See the module doc for the shapes and for why this is
 * pure.
 * @param params See {@link ComposeAmbientLinesParams}.
 * @returns Zero to two lines, ready for {@link withAmbientLines}.
 */
export function composeAmbientLines(params: ComposeAmbientLinesParams): string[] {
    const { self, other, now, timezone, sharedQuotaNote = false, providerSnapshot, anthropicQuotaSource = 'provider' } = params;
    // Merged per window from both ledgers rather than taken from one of them — see freshestDatedWindow.
    const quota = providerSnapshot === undefined
        ? quotaLine(self.quota, other?.quota, now, timezone, sharedQuotaNote, anthropicQuotaSource)
        : providerLine(providerSnapshot, self.quota, other?.quota, now, timezone, sharedQuotaNote, anthropicQuotaSource);
    return [
        ...other === undefined ? [] : [otherSessionLine(other, now, timezone)],
        ...quota === undefined ? [] : [quota],
    ];
}

/**
 * Appends `lines` to an already-formatted time header as further bullets of its list, so the
 * ambient facts arrive inside the block the model already reads for "where am I in time" rather
 * than as a second stanza it has to correlate. An empty `lines` needs no special case: joining a
 * one-element array yields `timeHeader` itself, unchanged.
 * @param timeHeader The header `formatTimeHeader` produced
 * @param lines The output of {@link composeAmbientLines}
 * @returns The header, with one `- ` bullet appended per line
 */
export function withAmbientLines(timeHeader: string, lines: readonly string[]): string {
    return [timeHeader, ...lines.map(line => `- ${line}`)].join('\n');
}
