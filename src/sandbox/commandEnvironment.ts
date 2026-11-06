import { z } from 'zod';

export function isInternalEnvironmentVariable(name: string): boolean {
  return name.toUpperCase() === 'EMA_SHARED_SECRET';
}

const variableName = z.string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine(name => !isInternalEnvironmentVariable(name), {
    message: 'Ema control credentials cannot be forwarded to child processes.',
  });

export const commandEnvironmentSchema = z.object({
  /** Values explicitly configured for Agent shell commands, not the interactive terminal. */
  values: z.record(variableName, z.string().max(32_768)),
  /** Names read from the Server environment when the Turn prepares its commands. */
  passthrough: z.array(variableName).max(64),
}).strict();

export type CommandEnvironment = z.infer<typeof commandEnvironmentSchema>;
