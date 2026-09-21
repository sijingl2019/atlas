// Host-side actions an agent attaches to one of its advertised slash commands.
//
// ACP has no notion of a "command that runs on the client": an advertised
// command is a name, a description and an optional input hint, and sending it
// as a prompt is the only protocol-level way to run it. The official Codex
// adapter (@agentclientprotocol/codex-acp) extends that with a proprietary
// `_meta.commandAction` block. That is how Codex Desktop knows `/plan` is a
// config switch rather than a model turn: sent as a prompt, the adapter flips
// the option server-side and answers with nothing, which rendered in Atlas as
// an empty assistant turn next to a user bubble.
//
// Recognised today:
//   { kind: "setConfigOption", configId, value, resetValue?, presentation? }
//     -> run `session/set_config_option` in the host; never send a prompt.
//
// Everything else (`prefixPrompt`, a missing or malformed block) stays
// passthrough: Atlas renders what ACP gives it and only claims the behaviour
// an agent actually spelled out (ADR 0003).

/** A host-side action an advertised command carries. */
export interface SlashConfigAction {
  /** ACP config option id, e.g. "collaboration_mode". */
  configId: string;
  /** The value to set. */
  value: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The host-side action an advertised command carries, if any.
 *
 *  Tolerant by design: `_meta` is untyped by contract, so anything that is
 *  not exactly a `setConfigOption` action reads as "no action" and the command
 *  stays passthrough. */
export function configActionOf(command: unknown): SlashConfigAction | null {
  if (!command || typeof command !== "object") return null;
  const meta = (command as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object") return null;
  const action = (meta as Record<string, unknown>).commandAction;
  if (!action || typeof action !== "object") return null;
  const a = action as Record<string, unknown>;
  if (str(a.kind) !== "setConfigOption") return null;
  const configId = str(a.configId);
  const value = str(a.value);
  if (!configId || !value) return null;
  return { configId, value };
}

/** The action a fully typed `/command` resolves to, or null to send it.
 *
 *  The picker's Enter/Tab path goes through `handleSlashSelect` and never
 *  reaches here; this is the backstop for text typed by hand and submitted
 *  with the picker already closed. Exact match only -- `/plan do the thing` is
 *  not the bare command, and is left to the agent's own usage reply rather
 *  than guessed at. */
export function resolveSlashSubmission(
  text: string,
  commands: readonly { name: string; configAction?: SlashConfigAction }[],
): SlashConfigAction | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || /\s/.test(trimmed)) return null;
  const name = trimmed.slice(1);
  if (!name) return null;
  const match = commands.find((c) => c.name === name && c.configAction);
  return match?.configAction ?? null;
}
