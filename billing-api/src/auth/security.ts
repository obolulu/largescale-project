/** Password hashing, JWT issue/verify, and the subscriber-scoping rule. */
import bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';

import { ApiError, forbidden, unauthorized } from '../common/api-error';
import { getSettings } from '../config';
import { Role, ROLES } from '../database/enums';

export function hashPassword(password: string, rounds = 12): string {
  return bcrypt.hashSync(password, rounds);
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export class Principal {
  constructor(
    readonly username: string,
    readonly role: Role,
    readonly subscriberNo: string | null,
  ) {}

  get isAdmin(): boolean {
    return this.role === Role.ADMIN;
  }
}

/** Returns the signed token and its lifetime in seconds. */
export function createAccessToken(user: {
  username: string;
  role: Role;
  subscriberNo: string | null;
}): { token: string; lifetime: number } {
  const s = getSettings();
  const now = Math.floor(Date.now() / 1000);
  const lifetime = s.jwtExpireMinutes * 60;
  const claims = {
    sub: user.username,
    role: user.role,
    subscriber_no: user.subscriberNo,
    iss: s.jwtIssuer,
    aud: s.jwtAudience,
    iat: now,
    exp: now + lifetime,
  };
  return { token: jwt.sign(claims, s.jwtSecret, { algorithm: s.jwtAlgorithm }), lifetime };
}

const REQUIRED_CLAIMS = ['sub', 'role', 'exp', 'iss', 'aud'] as const;

export function decodeAccessToken(token: string): Principal {
  const s = getSettings();
  let claims: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, s.jwtSecret, {
      algorithms: [s.jwtAlgorithm],
      audience: s.jwtAudience,
      issuer: s.jwtIssuer,
    });
    if (typeof decoded === 'string') throw new Error('token payload is not an object');
    claims = decoded;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw unauthorized('Token has expired.');
    throw unauthorized('Token is invalid.');
  }
  const role = claims.role as Role;
  if (
    REQUIRED_CLAIMS.some((name) => claims[name] === undefined || claims[name] === null) ||
    typeof claims.sub !== 'string' ||
    !ROLES.includes(role)
  ) {
    throw unauthorized('Token is invalid.');
  }
  const subscriberNo = typeof claims.subscriber_no === 'string' ? claims.subscriber_no : null;
  if (role === Role.SUBSCRIBER && !subscriberNo) throw unauthorized('Token is invalid.');
  return new Principal(claims.sub, role, subscriberNo);
}

/**
 * Which subscriber a protected call acts on.
 *
 * A subscriber always acts on the subscriber number in their token. Passing a
 * different number (for example one typed into the chat) is refused, so the
 * agent can never read or pay another person's bill. Admins must name one.
 */
export function resolveSubscriber(principal: Principal, requested: string | null | undefined): string {
  if (principal.isAdmin) {
    if (!requested) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'subscriber_no is required for admin requests.', [
        { field: 'subscriber_no', message: 'Field required' },
      ]);
    }
    return requested;
  }
  if (requested && requested !== principal.subscriberNo) {
    throw forbidden('You can only access your own subscriber account.');
  }
  return principal.subscriberNo as string; // guaranteed by decodeAccessToken
}
