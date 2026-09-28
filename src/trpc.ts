import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { z } from 'zod';
import type { TrpcContext } from './context';
import { hasAdministratorEmailAccess } from './adminAuthorization';
import { hasAdministratorAccessProof } from './adminAccessCode';

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

/** Requires a Firebase ID token verified by the server request context. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.uid) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please sign in to continue.' });
  }
  return next({ ctx: { ...ctx, uid: ctx.uid } });
});

/** Requires the same Firebase identity and short-lived access-code proof as the admin REST API. */
export const administratorProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.email || !(await hasAdministratorEmailAccess(ctx.email)) || !hasAdministratorAccessProof(ctx.email, ctx.adminAccessProof)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Administrator access is required.' });
  }
  return next();
});

/**
 * Binds a client-provided identity field to the verified Firebase UID.
 * Use this for any procedure whose input includes driverId, riderId, or userId.
 */
export function identityProcedure<TSchema extends z.ZodTypeAny>(schema: TSchema, identityField: string) {
  return protectedProcedure.input(schema).use(({ ctx, input, next }) => {
    const claimedUid = String((input as Record<string, unknown> | undefined)?.[identityField] || '').trim();
    if (!claimedUid || claimedUid !== ctx.uid) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'This request does not belong to the signed-in account.' });
    }
    return next();
  });
}

/** Binds every Driver operation to the verified Driver Firebase UID. */
export function driverProcedure<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return identityProcedure(schema, 'driverId');
}

/** Binds every Rider operation to the verified Rider Firebase UID. */
export function riderProcedure<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return identityProcedure(schema, 'riderId');
}

/** Binds a generic userId input to the verified Firebase UID. */
export function userProcedure<TSchema extends z.ZodTypeAny>(schema: TSchema) {
  return identityProcedure(schema, 'userId');
}
