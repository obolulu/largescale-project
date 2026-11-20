import {
  applyDecorators,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';

import { forbidden, unauthorized } from '../common/api-error';
import { decodeAccessToken, Principal } from './security';

export const BEARER_SCHEME = 'HTTPBearer';

type AuthedRequest = Request & { principal?: Principal };

/** `Authorization: Bearer <token>`; anything else counts as no token. */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const space = header.indexOf(' ');
  const scheme = space === -1 ? header : header.slice(0, space);
  const credentials = space === -1 ? '' : header.slice(space + 1).trim();
  if (scheme.toLowerCase() !== 'bearer' || !credentials) return null;
  return credentials;
}

@Injectable()
export class BearerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(req.headers.authorization);
    if (token === null) throw unauthorized();
    req.principal = decodeAccessToken(token);
    return true;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const principal = context.switchToHttp().getRequest<AuthedRequest>().principal;
    if (!principal?.isAdmin) throw forbidden('This operation requires the ADMIN role.');
    return true;
  }
}

/** Any valid token. Guards run before validation, so a missing token is 401 even with a bad body. */
export const Authenticated = () => applyDecorators(UseGuards(BearerGuard), ApiBearerAuth(BEARER_SCHEME));

/** A valid token with the ADMIN role. */
export const AdminOnly = () => applyDecorators(UseGuards(BearerGuard, AdminGuard), ApiBearerAuth(BEARER_SCHEME));

/** The authenticated caller, set by BearerGuard. */
export const CurrentPrincipal = createParamDecorator(
  (_: unknown, context: ExecutionContext): Principal =>
    context.switchToHttp().getRequest<AuthedRequest>().principal as Principal,
);
