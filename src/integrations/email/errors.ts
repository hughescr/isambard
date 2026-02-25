import { IsambardError, ErrorCode } from '@/errors';

export class EmailError extends IsambardError {
    constructor(message: string, code: ErrorCode = ErrorCode.EMAIL_ERROR, context?: Record<string, unknown>) {
        super(message, code, context);
        this.name = 'EmailError';
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

export class WildDuckError extends EmailError {
    constructor(message: string, code: ErrorCode = ErrorCode.WILDDUCK_ERROR, context?: Record<string, unknown>) {
        super(message, code, context);
        this.name = 'WildDuckError';
    }
}

export class WildDuckAuthError extends WildDuckError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, ErrorCode.WILDDUCK_AUTH_ERROR, context);
        this.name = 'WildDuckAuthError';
    }
}
