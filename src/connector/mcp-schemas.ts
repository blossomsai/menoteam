import { z } from 'zod';

/** Shared with the actual MCP registration, so explicit choices survive strict parsing. */
export const createWorkSchema = z.object({
  title: z.string().min(1).max(32_000),
  overview: z.string().max(32_000).optional(),
  profileId: z.string().max(200).optional(),
  connectionId: z.string().min(1).max(200).optional(),
  sources: z.array(z.string().max(2000)).max(100).optional(),
}).strict();
