// IDs de modèles Anthropic, timeouts, et caps de robustesse.
// Modèles vérifiés (Anthropic, juin 2026) :
//   - Sonnet-class pour REASON + WRITE + persona : "claude-sonnet-4-6"
//   - Haiku-class pour VERIFY (modèle léger)     : "claude-haiku-4-5"
// On ne devine pas les IDs : ce sont les aliases stables courants.
import type { ChannelHint } from "./types";

export const MODELS = {
  reason: "claude-sonnet-4-6",
  write: "claude-sonnet-4-6",
  persona: "claude-sonnet-4-6",
  verify: "claude-haiku-4-5",
} as const;

// Timeouts par appel LLM (ms). Au-delà → fallback déterministe.
// Right-sized : un appel Sonnet lent (mais correct) ne doit PAS tripper le fallback.
export const TIMEOUTS = {
  reason: 45_000,
  write: 45_000,
  persona: 45_000,
  verify: 20_000,
} as const;

// Plafonds de tokens de sortie (non-streaming, < 16k → pas de timeout SDK).
export const MAX_TOKENS = {
  reason: 2048,
  write: 1500,
  persona: 800,
  verify: 512,
} as const;

// Caps de robustesse : jamais de boucle infinie.
export const CAPS = {
  // Nombre maximum de ré-écritures du message après échec de VERIFY.
  maxRevisions: 1,
  // Retry sur échec de parse/schéma Zod d'une sortie LLM structurée.
  schemaRetries: 1,
  // Longueur max du body par canal (caractères), right-sized.
  // hook = 1er message (accroche, plus court) ; answer = message-réponse (plus long).
  maxBodyChars: {
    email: { hook: 2000, answer: 2400 },
    linkedin: { hook: 900, answer: 1500 },
    sms: { hook: 320, answer: 320 },
  },
} as const;

// Limite de caractères du body selon le canal et le type de message (accroche vs réponse).
export function channelLimit(channel: ChannelHint, isHook: boolean): number {
  const c = CAPS.maxBodyChars[channel] ?? CAPS.maxBodyChars.email;
  return isHook ? c.hook : c.answer;
}

// Le modèle exposé dans meta.model.
export const META_MODEL = MODELS.reason;
