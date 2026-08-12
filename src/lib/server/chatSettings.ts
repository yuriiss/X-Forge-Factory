import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentStatuses } from "./agents";
import { stateFile } from "./paths";
import { providers } from "./providers";

/**
 * The model the console is currently talking to.
 *
 * It is one choice, kept on the server rather than in a browser, because it is a fact about
 * this installation rather than about a tab: an operator who picks Grok and then opens the
 * console on their phone is still talking to Grok. Chat is one conversation with a model
 * selector, not six conversations behind six buttons.
 *
 * A saved choice is returned even when the model is not currently reachable. Silently
 * substituting another one would mean an operator sends a prompt to something they did not
 * pick — the console says the CLI is missing instead, and lets them decide.
 */

export interface ChatChoice {
  /** A CLI id (`claude`) or a provider id when `provider` is true. */
  id: string;
  provider: boolean;
  /** The model within that provider, which a CLI does not need. */
  model?: string;
}

interface Stored {
  choice?: ChatChoice;
}

function file(): string {
  return stateFile("chat.json");
}

function read(): Stored {
  try {
    const f = file();
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Stored) : {};
  } catch {
    return {};
  }
}

export function getChoice(): ChatChoice {
  const saved = read().choice;
  if (saved?.id) return saved;

  // No choice yet: the first CLI that is actually installed, so a fresh console opens on
  // something that works rather than on something that has to be fixed first.
  const installed = agentStatuses().find((a) => a.available);
  if (installed) return { id: installed.id, provider: false };

  const configured = providers().find((p) => p.configured);
  return configured ? { id: configured.id, provider: true } : { id: "claude", provider: false };
}

export function setChoice(choice: ChatChoice): ChatChoice {
  const known = choice.provider ? providers().some((p) => p.id === choice.id) : agentStatuses().some((a) => a.id === choice.id);
  if (!known) throw new Error(`unknown model: ${choice.id}`);

  const f = file();
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ ...read(), choice }, null, 2), "utf8");
  return choice;
}
