import { z } from 'zod';
import type { LayerName } from './types';

/**
 * Configuration schema for memory tool layers.
 * - maxVersions: Maximum number of versions to retain
 * - autoLoad: Whether to auto-load on agent startup (true|false|'conditional')
 */
export const layerConfigSchema = z.object({
    maxVersions: z.number().int().positive().default(1),
    autoLoad:    z.union([z.boolean(), z.literal('conditional')]).default(false),
});

export type LayerConfig = z.infer<typeof layerConfigSchema>;

/**
 * Layer-specific configurations for the memory tool.
 *
 * - identity: Core beliefs, values, and self-model (permanent, high retention)
 * - state: Current context and working memory (permanent, moderate retention)
 * - events: Historical timeline and experiences (permanent, minimal retention)
 */
export const LAYER_CONFIGS = {
    identity: { maxVersions: 10, autoLoad: true },
    state:    { maxVersions: 5, autoLoad: 'conditional' },
    events:   { maxVersions: 1, autoLoad: false },
} as const satisfies Record<string, LayerConfig>;

/**
 * Retrieves the configuration for a specific memory layer.
 * @param layer - The layer name (identity, state, or events)
 * @returns The layer configuration
 */
export function getLayerConfig(layer: LayerName): LayerConfig {
    // Cast to string to access the key, since LayerName is branded
    return LAYER_CONFIGS[layer as string as keyof typeof LAYER_CONFIGS];
}
