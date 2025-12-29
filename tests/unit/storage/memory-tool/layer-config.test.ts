import { describe, it, expect } from 'bun:test';
import _ from 'lodash';
import {
    layerConfigSchema,
    LAYER_CONFIGS,
    getLayerConfig
} from '@/storage/memory-tool/layer-config';
import type { LayerName } from '@/storage/memory-tool/types';

describe('layerConfigSchema', () => {
    it('should validate config with all fields', () => {
        const config = {
            maxVersions: 5,
            autoLoad:    'conditional' as const,
        };
        const result = layerConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    it('should apply default maxVersions of 1', () => {
        const config = {
            autoLoad: false,
        };
        const result = layerConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.maxVersions).toBe(1);
        }
    });

    it('should apply default autoLoad of false', () => {
        const config = {
            maxVersions: 3,
        };
        const result = layerConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.autoLoad).toBe(false);
        }
    });

    it('should accept boolean autoLoad', () => {
        const configTrue = {
            maxVersions: 3,
            autoLoad:    true,
        };
        const resultTrue = layerConfigSchema.safeParse(configTrue);
        expect(resultTrue.success).toBe(true);

        const configFalse = {
            maxVersions: 3,
            autoLoad:    false,
        };
        const resultFalse = layerConfigSchema.safeParse(configFalse);
        expect(resultFalse.success).toBe(true);
    });

    it('should accept "conditional" for autoLoad', () => {
        const config = {
            maxVersions: 3,
            autoLoad:    'conditional' as const,
        };
        const result = layerConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    it('should reject invalid string for autoLoad', () => {
        const config = {
            maxVersions: 3,
            autoLoad:    'always',
        };
        const result = layerConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('should reject negative maxVersions', () => {
        const config = {
            maxVersions: -1,
            autoLoad:    false,
        };
        const result = layerConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('should reject zero maxVersions', () => {
        const config = {
            maxVersions: 0,
            autoLoad:    false,
        };
        const result = layerConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    it('should reject non-integer maxVersions', () => {
        const config = {
            maxVersions: 3.5,
            autoLoad:    false,
        };
        const result = layerConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });
});

describe('LAYER_CONFIGS', () => {
    it('should have entries for all 3 layers', () => {
        expect(LAYER_CONFIGS).toHaveProperty('identity');
        expect(LAYER_CONFIGS).toHaveProperty('state');
        expect(LAYER_CONFIGS).toHaveProperty('events');
        expect(_.keys(LAYER_CONFIGS)).toHaveLength(3);
    });

    it('should have identity config with correct values', () => {
        const config = getLayerConfig('identity' as LayerName);
        expect(config.maxVersions).toBe(10);
        expect(config.autoLoad).toBe(true);
    });

    it('should have state config with correct values', () => {
        const config = getLayerConfig('state' as LayerName);
        expect(config.maxVersions).toBe(5);
        expect(config.autoLoad).toBe('conditional');
    });

    it('should have events config with correct values', () => {
        const config = getLayerConfig('events' as LayerName);
        expect(config.maxVersions).toBe(1);
        expect(config.autoLoad).toBe(false);
    });

    it('should have all configs validate against schema', () => {
        for(const layer of ['identity', 'state', 'events'] as const) {
            const config = getLayerConfig(layer as LayerName);
            const result = layerConfigSchema.safeParse(config);
            expect(result.success).toBe(true);
        }
    });
});

describe('getLayerConfig', () => {
    it('should return identity config with correct values', () => {
        const config = getLayerConfig('identity' as LayerName);
        expect(config.maxVersions).toBe(10);
        expect(config.autoLoad).toBe(true);
    });

    it('should return state config with correct values', () => {
        const config = getLayerConfig('state' as LayerName);
        expect(config.maxVersions).toBe(5);
        expect(config.autoLoad).toBe('conditional');
    });

    it('should return events config with correct values', () => {
        const config = getLayerConfig('events' as LayerName);
        expect(config.maxVersions).toBe(1);
        expect(config.autoLoad).toBe(false);
    });

    it('should return the same reference for repeated calls', () => {
        const config1 = getLayerConfig('identity' as LayerName);
        const config2 = getLayerConfig('identity' as LayerName);
        expect(config1).toBe(config2);
    });
});
