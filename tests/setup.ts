// Test setup and configuration
//
// Silence all log messages while in test to avoid blowing up stryker
import { forEach } from 'lodash';
import { logger } from '@hughescr/logger';
forEach(logger.transports, t => t.silent = true);
