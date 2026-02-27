import { describe, test, expect } from 'bun:test';
import keys from 'lodash/keys';
import {
    layerConfigSchema,
    LAYER_CONFIGS,
    getLayerConfig
} from '@/storage/memory-tool/layer-config';
import type { LayerName } from '@/storage/memory-tool/types';

describe.concurrent('layerConfigSchema', () => {
    // First Zod parse has slight cold-start, allow 5ms
    test('should validate config with autoLoad conditional', () => {
        const config = {
            autoLoad: 'conditional' as const,
        };
        const result = layerConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    }, { timeout: process.env.CI ? 50 : 5 });

    test('should apply default autoLoad of false', () => {
        const config = {};
        const result = layerConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.autoLoad).toBe(false);
        }
    });

    test('should accept boolean autoLoad', () => {
        const configTrue = {
            autoLoad: true,
        };
        const resultTrue = layerConfigSchema.safeParse(configTrue);
        expect(resultTrue.success).toBe(true);

        const configFalse = {
            autoLoad: false,
        };
        const resultFalse = layerConfigSchema.safeParse(configFalse);
        expect(resultFalse.success).toBe(true);
    });

    test('should accept "conditional" for autoLoad', () => {
        const config = {
            autoLoad: 'conditional' as const,
        };
        const result = layerConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    test('should reject invalid string for autoLoad', () => {
        const config = {
            autoLoad: 'always',
        };
        const result = layerConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });
});

describe.concurrent('LAYER_CONFIGS', () => {
    test('should have entries for all 3 layers', () => {
        expect(LAYER_CONFIGS).toHaveProperty('identity');
        expect(LAYER_CONFIGS).toHaveProperty('state');
        expect(LAYER_CONFIGS).toHaveProperty('events');
        expect(keys(LAYER_CONFIGS)).toHaveLength(3);
    });

    test('should have identity config with correct values', () => {
        const config = getLayerConfig('identity' as LayerName);
        expect(config.autoLoad).toBe(true);
    });

    test('should have state config with correct values', () => {
        const config = getLayerConfig('state' as LayerName);
        expect(config.autoLoad).toBe('conditional');
    });

    test('should have events config with correct values', () => {
        const config = getLayerConfig('events' as LayerName);
        expect(config.autoLoad).toBe(false);
    });

    test('should have all configs validate against schema', () => {
        for(const layer of ['identity', 'state', 'events'] as const) {
            const config = getLayerConfig(layer as LayerName);
            const result = layerConfigSchema.safeParse(config);
            expect(result.success).toBe(true);
        }
    });
});

describe.concurrent('getLayerConfig', () => {
    test('should return identity config with correct values', () => {
        const config = getLayerConfig('identity' as LayerName);
        expect(config.autoLoad).toBe(true);
    });

    test('should return state config with correct values', () => {
        const config = getLayerConfig('state' as LayerName);
        expect(config.autoLoad).toBe('conditional');
    });

    test('should return events config with correct values', () => {
        const config = getLayerConfig('events' as LayerName);
        expect(config.autoLoad).toBe(false);
    });

    test('should return the same reference for repeated calls', () => {
        const config1 = getLayerConfig('identity' as LayerName);
        const config2 = getLayerConfig('identity' as LayerName);
        expect(config1).toBe(config2);
    });
});
