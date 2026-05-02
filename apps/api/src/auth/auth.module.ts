// =============================================================================
// apps/api/src/auth/auth.module.ts (and friends, all in one file for clarity)
// =============================================================================
// In a real repo split this into:
//   auth.module.ts
//   strategies/jwt.strategy.ts
//   guards/jwt-auth.guard.ts
//   guards/roles.guard.ts
//   decorators/current-user.decorator.ts
//   decorators/roles.decorator.ts
//   types.ts
// =============================================================================

import {
  CanActivate, createParamDecorator, ExecutionContext, Injectable,
  Module, SetMetadata, UnauthorizedException, ForbiddenException,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface AuthUser {
  id: string;          // user uuid
  tenantId: string;    // tenant uuid
  email: string;
  roles: string[];     // role codes: ['owner','agronomist',...]
  scopes: string[];    // permission strings
  deviceId?: string;   // populated for mobile requests
}

export interface JwtPayload {
  sub: string;         // user id
  tid: string;         // tenant id
  email: string;
  roles: string[];
  scopes: string[];
  device_id?: string;  // mobile-issued tokens carry the device id
  iat: number;
  exp: number;
}

// -----------------------------------------------------------------------------
// Decorators
// -----------------------------------------------------------------------------

/** `@CurrentUser() user: AuthUser` */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthUser;
  },
);

/** `@Roles('owner','accountant')` — combined with RolesGuard */
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);

/** `@Public()` — opt out of JwtAuthGuard for specific endpoints */
export const Public = () => SetMetadata('isPublic', true);

// -----------------------------------------------------------------------------
// JWT strategy
// -----------------------------------------------------------------------------

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        // Web: httpOnly cookie
        (req) => req?.cookies?.access_token ?? null,
        // Mobile + integrations: Authorization: Bearer <token>
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_ACCESS_SECRET!,
      passReqToCallback: true,
    });
  }

  async validate(req: any, payload: JwtPayload): Promise<AuthUser> {
    // The token is signed, so we trust its content for the hot path.
    // Heavy revocation/role-changed checks should run at login + occasional
    // refresh, not on every request — otherwise a Postgres roundtrip per
    // call kills your throughput.
    if (!payload?.sub || !payload?.tid) {
      throw new UnauthorizedException('malformed token');
    }
    return {
      id: payload.sub,
      tenantId: payload.tid,
      email: payload.email,
      roles: payload.roles ?? [],
      scopes: payload.scopes ?? [],
      deviceId: payload.device_id,
    };
  }
}

// -----------------------------------------------------------------------------
// Guards
// -----------------------------------------------------------------------------

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }
  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const { user } = context.switchToHttp().getRequest();
    if (!user || !required.some((r) => user.roles.includes(r))) {
      throw new ForbiddenException('insufficient role');
    }
    return true;
  }
}

// -----------------------------------------------------------------------------
// Login service (sketch — flesh out password reset, MFA, etc. as needed)
// -----------------------------------------------------------------------------

import { compare, hash } from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  /**
   * Login is a cross-tenant operation, so it runs WITHOUT the tenant GUC.
   * The `app_admin` role (BYPASSRLS) is appropriate for this connection.
   * In practice you'd have a separate Prisma client wired with that role.
   */
  async login(email: string, password: string, deviceId?: string) {
    // NOTE: this query bypasses RLS — see the comment above. In dev with the
    // same role as the app, RLS will block this unless app.tenant_id is set
    // to a sentinel. Pragmatic dev workaround: prefix login users with email,
    // and use a SECURITY DEFINER function for cross-tenant lookup.
    const user = await this.prisma.user.findFirst({
      where: { email },
      include: { roles: { include: { role: true } } },
    });
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('invalid credentials');
    }
    const ok = await compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('invalid credentials');

    const roleCodes = user.roles.map((ur) => ur.role.code);
    const scopes = Array.from(
      new Set(user.roles.flatMap((ur) => ur.role.scopes)),
    );

    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: user.id,
      tid: user.tenantId,
      email: user.email,
      roles: roleCodes,
      scopes,
      device_id: deviceId,
    };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: process.env.JWT_ACCESS_SECRET!,
      expiresIn: '15m',
    });
    const refreshToken = await this.jwt.signAsync(payload, {
      secret: process.env.JWT_REFRESH_SECRET!,
      expiresIn: deviceId ? '90d' : '14d', // mobile gets longer refresh
    });

    // Store hashed refresh token for revocation. Skipped here for brevity.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return { accessToken, refreshToken, user: { id: user.id, email: user.email, roles: roleCodes } };
  }

  /** Helper for seeding / admin scripts */
  static async hashPassword(plain: string): Promise<string> {
    return hash(plain, 12);
  }
}

// -----------------------------------------------------------------------------
// Module
// -----------------------------------------------------------------------------

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}), // secrets passed per-call so we can use different keys for access/refresh
  ],
  providers: [JwtStrategy, JwtAuthGuard, RolesGuard, AuthService],
  exports: [JwtAuthGuard, RolesGuard, AuthService],
})
export class AuthModule {}
