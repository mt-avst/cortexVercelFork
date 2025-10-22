"use strict";
// Shared Type Definitions for Adaptalabs Application
// This file contains all common interfaces used by both frontend and backend
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBooking = exports.isSession = exports.isOpportunity = exports.isSessionUser = exports.isUser = exports.NetworkError = exports.TimeoutError = exports.ForbiddenError = exports.UnauthorizedError = exports.ConflictError = exports.NotFoundError = exports.ValidationError = exports.AppError = void 0;
// Base error class
class AppError extends Error {
    constructor(message, statusCode = 500, code, details, requestId) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.isOperational = true;
        this.code = code;
        this.details = details;
        this.requestId = requestId;
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.AppError = AppError;
// Specific error classes
class ValidationError extends AppError {
    constructor(message, details) {
        super(message, 400, 'VALIDATION_ERROR', details);
    }
}
exports.ValidationError = ValidationError;
class NotFoundError extends AppError {
    constructor(resource) {
        super(`${resource} not found`, 404, 'NOT_FOUND');
    }
}
exports.NotFoundError = NotFoundError;
class ConflictError extends AppError {
    constructor(message) {
        super(message, 409, 'CONFLICT');
    }
}
exports.ConflictError = ConflictError;
class UnauthorizedError extends AppError {
    constructor(message = 'Unauthorized') {
        super(message, 401, 'UNAUTHORIZED');
    }
}
exports.UnauthorizedError = UnauthorizedError;
class ForbiddenError extends AppError {
    constructor(message = 'Forbidden') {
        super(message, 403, 'FORBIDDEN');
    }
}
exports.ForbiddenError = ForbiddenError;
class TimeoutError extends AppError {
    constructor(message = 'Request timeout') {
        super(message, 408, 'TIMEOUT');
    }
}
exports.TimeoutError = TimeoutError;
class NetworkError extends AppError {
    constructor(message = 'Network error') {
        super(message, 0, 'NETWORK_ERROR');
    }
}
exports.NetworkError = NetworkError;
// ============================================================================
// TYPE GUARDS
// ============================================================================
const isUser = (obj) => {
    return obj && typeof obj.id === 'string' && typeof obj.name === 'string' && typeof obj.email === 'string';
};
exports.isUser = isUser;
const isSessionUser = (obj) => {
    return obj && typeof obj.id === 'string' && typeof obj.name === 'string' && typeof obj.email === 'string';
};
exports.isSessionUser = isSessionUser;
const isOpportunity = (obj) => {
    return obj && typeof obj.id === 'string' && typeof obj.title === 'string' && typeof obj.purpose_one_liner === 'string';
};
exports.isOpportunity = isOpportunity;
const isSession = (obj) => {
    return obj && typeof obj.id === 'string' && typeof obj.opportunity_id === 'string' && typeof obj.start_time === 'string';
};
exports.isSession = isSession;
const isBooking = (obj) => {
    return obj && typeof obj.id === 'string' && typeof obj.user_id === 'string' && typeof obj.session_id === 'string';
};
exports.isBooking = isBooking;
