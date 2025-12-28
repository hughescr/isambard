/* eslint-disable n/no-process-exit, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @stylistic/max-statements-per-line, @typescript-eslint/no-floating-promises, no-console, lodash/prefer-lodash-method, @typescript-eslint/no-unused-vars, lodash/prefer-lodash-typecheck -- Test script requires direct console access and process.exit */
/**
 * Quick OAuth sanity check for Agent SDK
 *
 * Run with: CLAUDE_CODE_OAUTH_TOKEN=<your-token> bun scripts/test-oauth.ts
 *
 * Get token via: claude setup-token
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

async function testOAuth() {
    // Clear API key to ensure we're testing OAuth only
    delete process.env.ANTHROPIC_API_KEY;

    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;

    if(!token) {
        console.error('❌ CLAUDE_CODE_OAUTH_TOKEN not set');
        console.log('\nTo get a token:');
        console.log('  1. Run: claude setup-token');
        console.log('  2. Copy the token');
        console.log('  3. Run: CLAUDE_CODE_OAUTH_TOKEN=<token> bun scripts/test-oauth.ts');
        process.exit(1);
    }

    console.log('🔐 Testing OAuth authentication with Agent SDK...');
    console.log(`   Token prefix: ${token.substring(0, 20)}...`);
    console.log('   API key cleared: ✓');
    console.log('');

    try {
        const response = query({
            prompt:  'Say "OAuth test successful!" and nothing else.',
            options: {
                model:          'claude-sonnet-4-5',
                allowedTools:   [],
                permissionMode: 'bypassPermissions',
            }
        });

        let fullResponse = '';

        for await (const message of response) {
            console.log('Message:', JSON.stringify(message, null, 2));

            if(message.type === 'assistant') {
                // Extract text from message content blocks
                const textBlocks = message.message?.content?.filter((b: any) => b.type === 'text') || [];
                const text = textBlocks.map((b: any) => b.text).join('');
                if(text) { fullResponse += text; }
            } else if('result' in message && message.result) {
                fullResponse = String(message.result);
            }
        }

        console.log('\n');
        console.log('✅ OAuth authentication WORKS!');
        console.log('   You can proceed with the migration to Agent SDK.');
    } catch (error) {
        console.error('\n❌ OAuth authentication FAILED');
        console.error('   Error:', error instanceof Error ? error.message : String(error));
        console.log('\n   This could mean:');
        console.log('   - Token is invalid or expired');
        console.log('   - Agent SDK doesn\'t support OAuth for this use case');
        console.log('   - Network/rate limit issue');
        process.exit(1);
    }
}

testOAuth();
