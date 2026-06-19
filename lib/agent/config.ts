// IDs de modèles Anthropic, timeouts, et caps de robustesse.
// Modèles vérifiés (Anthropic, juin 2026) :
//   - Sonnet-class pour REASON + WRITE + persona : "claude-sonnet-4-6"
//   - Haiku-class pour VERIFY (modèle léger)     : "claude-haiku-4-5"
// On ne devine pas les IDs : ce sont les aliases stables courants.

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
  // Longueur max du body par canal (caractères).
  maxBodyChars: { email: 1800, linkedin: 750, sms: 320 } as Record<string, number>,
} as const;

// Le modèle exposé dans meta.model.
export const META_MODEL = MODELS.reason;
