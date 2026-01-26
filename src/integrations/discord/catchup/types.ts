/**
 * Catch-up state machine states.
 *
 * State transitions:
 * - idle: Normal operation, waiting for messages (not catching up)
 * - catching_up: Processing unread backlog (inbox tools available)
 * - catching_up_interrupted: Handling new message during catch-up
 * - processing_message: Normal message handling (not catch-up mode)
 */
export type CatchUpState = 'idle' | 'catching_up' | 'catching_up_interrupted' | 'processing_message';
