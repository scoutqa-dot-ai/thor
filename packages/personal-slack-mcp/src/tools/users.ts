import { z } from "zod";
import type { SlackDeps } from "../slack-client.js";

export const ListUsersInput = z.object({
  limit: z.number().min(1).max(200).default(100).describe("Max users to return"),
  cursor: z.string().optional().describe("Pagination cursor"),
});

export const GetUserProfileInput = z.object({
  user: z.string().describe("Slack user ID (e.g. U0123456789)"),
});

export async function listUsers(
  args: z.infer<typeof ListUsersInput>,
  deps: SlackDeps,
) {
  const result = await deps.client.users.list({
    limit: args.limit,
    cursor: args.cursor,
  });
  return {
    users: (result.members ?? [])
      .filter((u) => !u.deleted && !u.is_bot)
      .map((u) => ({
        id: u.id,
        name: u.name,
        real_name: u.real_name,
        display_name: u.profile?.display_name,
        title: u.profile?.title,
        is_admin: u.is_admin,
      })),
    next_cursor: result.response_metadata?.next_cursor || undefined,
  };
}

export async function getUserProfile(
  args: z.infer<typeof GetUserProfileInput>,
  deps: SlackDeps,
) {
  const result = await deps.client.users.profile.get({
    user: args.user,
  });
  const p = result.profile;
  return {
    real_name: p?.real_name,
    display_name: p?.display_name,
    title: p?.title,
    email: p?.email,
    status_text: p?.status_text,
    status_emoji: p?.status_emoji,
  };
}
