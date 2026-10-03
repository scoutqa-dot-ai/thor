import { z } from "zod/v4";
import { ExecResultSchema } from "./exec-result.js";

/** Secret-gated broker readiness; exact blocked Google argv, never a shell replay. */
const GoogleAuthContinuationFieldsSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
  slackTeamId: z.string().min(1),
  slackUserId: z.string().min(1),
  sessionId: z.string().min(1),
  anchorId: z.string().min(1),
  triggerId: z.string().min(1),
  args: z.array(z.string().refine((arg) => !arg.includes("\0"))),
  connectionId: z.uuid(),
  createdAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
});
/** Validated broker readiness includes a positive-lived outbox lease. */
export const GoogleAuthContinuationSchema = GoogleAuthContinuationFieldsSchema.refine(
  (record) => record.expiresAtMs > record.createdAtMs,
);
/** Validated ready record; invitation request ID is the continuation identity. */
export type GoogleAuthContinuation = z.infer<typeof GoogleAuthContinuationSchema>;

/** Secret-gated informational wait binding; readiness alone authorizes continuation admission. */
export const GoogleAuthWaitBindingSchema = GoogleAuthContinuationFieldsSchema.omit({
  connectionId: true,
  args: true,
}).refine((record) => record.expiresAtMs > record.createdAtMs);
/** Original requester/turn whose confirmed private invitation is waiting or ready. */
export type GoogleAuthWaitBinding = z.infer<typeof GoogleAuthWaitBindingSchema>;

/** Informational auth wait result; this does not authorize a continuation. */
export const GoogleAuthWaitSchema = z.object({
  type: z.literal("google_auth_wait"),
  id: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
  expiresAtMs: z.number().int().positive(),
});
/** Confirmed private delivery without leaking the invitation URL or command payload. */
export type GoogleAuthWait = z.infer<typeof GoogleAuthWaitSchema>;
/** Compatible exec response with optional structured Google auth wait evidence. */
export const GoogleWorkspaceExecResultSchema = ExecResultSchema.extend({
  authWait: GoogleAuthWaitSchema.optional(),
});
/** Google execution response; readiness is obtained only from the secret-gated broker. */
export type GoogleWorkspaceExecResult = z.infer<typeof GoogleWorkspaceExecResultSchema>;
