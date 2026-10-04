import { z } from "zod";
import { SlackMessageTsSchema } from "./progress-events.js";

/** Trusted gateway proof after workspace equality, privacy and repository admission; never model input. */
export const SlackReplyAdmissionSchema = z.strictObject({
  version: z.literal(1),
  teamId: z
    .string()
    .regex(/^T[A-Z0-9_]+$/)
    .brand<"SlackReplyTeamId">(),
  channel: z
    .string()
    .regex(/^[CDG][A-Z0-9_]+$/)
    .brand<"SlackReplyChannelId">(),
  threadTs: SlackMessageTsSchema.brand<"SlackReplyThreadTs">(),
});
/** Frozen permitted destination for new Slack work, including private channels. */
export type SlackReplyAdmission = z.infer<typeof SlackReplyAdmissionSchema>;
