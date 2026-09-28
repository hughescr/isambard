/**
 * Browser module public API barrel.
 *
 * Other modules import from '@/agent/browser' (or './browser' in peer files)
 * rather than reaching into the individual source files.
 */
export { createWebViewAdapter } from './webview-adapter';
export type { BrowserAdapter, BrowserHostPolicy } from './types';
export { validateUrl, checkResolvedAddress, type ResolvedAddressResult } from './host-guard';
