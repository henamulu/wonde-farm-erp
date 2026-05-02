// =============================================================================
// apps/api/src/common/global-exception.filter.ts
// =============================================================================
// Single source of truth for error responses. Returns a consistent shape
// regardless of whether the error came from validation, auth, a known
// HttpException, a Prisma error, or an uncaught throw.
// =============================================================================

import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  request_id?: string;
  path: string;
  timestamp: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const { status, code, message, details } = this.normalize(exception);

    // Log 5xx / unexpected; warn for unauthorised; debug for others
    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} → ${status} ${code}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
      this.logger.warn(`${req.method} ${req.url} → ${status} ${code}`);
    } else {
      this.logger.debug?.(`${req.method} ${req.url} → ${status} ${code}: ${message}`);
    }

    const body: ErrorResponse = {
      error: { code, message, details },
      request_id: (req.headers['x-request-id'] as string) ?? undefined,
      path: req.url,
      timestamp: new Date().toISOString(),
    };

    res.status(status).json(body);
  }

  private normalize(e: unknown): {
    status: number; code: string; message: string; details?: unknown;
  } {
    // ---- Nest HttpException ----
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const r = e.getResponse() as any;
      // Nest validation pipe returns { message: string[] | string, error: string }
      if (typeof r === 'object' && r) {
        return {
          status,
          code: this.codeFromStatus(status, r.error),
          message: Array.isArray(r.message) ? r.message[0] : (r.message ?? r.error ?? 'error'),
          details: Array.isArray(r.message) ? r.message : undefined,
        };
      }
      return { status, code: this.codeFromStatus(status), message: String(r) };
    }

    // ---- Prisma known errors ----
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(e);
    }
    if (e instanceof Prisma.PrismaClientValidationError) {
      return { status: 400, code: 'invalid_input', message: 'invalid request body' };
    }

    // ---- Plain Error ----
    if (e instanceof Error) {
      return { status: 500, code: 'internal_error', message: 'internal server error' };
    }

    // ---- Anything else ----
    return { status: 500, code: 'internal_error', message: 'unknown error' };
  }

  private fromPrisma(e: Prisma.PrismaClientKnownRequestError) {
    switch (e.code) {
      case 'P2002': // unique constraint
        return {
          status: 409, code: 'conflict',
          message: 'resource already exists',
          details: { fields: (e.meta as any)?.target },
        };
      case 'P2003': // FK violation
        return {
          status: 400, code: 'invalid_reference',
          message: 'referenced resource does not exist',
          details: { field: (e.meta as any)?.field_name },
        };
      case 'P2025': // record not found
        return { status: 404, code: 'not_found', message: 'resource not found' };
      default:
        return { status: 500, code: 'database_error', message: `db error ${e.code}` };
    }
  }

  private codeFromStatus(status: number, fallback?: string): string {
    switch (status) {
      case 400: return 'invalid_input';
      case 401: return 'unauthenticated';
      case 403: return 'forbidden';
      case 404: return 'not_found';
      case 409: return 'conflict';
      case 422: return 'unprocessable';
      case 429: return 'rate_limited';
      case 500: return 'internal_error';
      case 503: return 'service_unavailable';
      default:  return fallback?.toLowerCase().replace(/\s+/g, '_') ?? 'error';
    }
  }
}
