import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';

export class EmailError extends IsambardError {
    constructor(message: string, code: ErrorCode = ErrorCode.EMAIL_ERROR, context?: Record<string, unknown>) {
        super(message, code, context);
        this.name = 'EmailError';
    }
}

export class ImapConnectionError extends EmailError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.IMAP_CONNECTION_ERROR, context);
        this.name = 'ImapConnectionError';
    }
}

export class ClassifierError extends EmailError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.CLASSIFIER_ERROR, context);
        this.name = 'ClassifierError';
    }
}

export class EmailProcessingError extends EmailError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.EMAIL_PROCESSING_ERROR, context);
        this.name = 'EmailProcessingError';
    }
}
