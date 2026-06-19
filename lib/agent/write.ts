import { z } from "zod";
import type { ChannelHint, NextMessage, Stage, VoiceProfile } from "./types";
import type { GroundingPack, ForbiddenList } from "./grounding";
import { renderForbiddenList } from "./grounding";
import { callStructured } from "./llm";
import { MODELS, MAX_TOKENS, TIMEOUTS, CAPS } from "./config";

const CHANNELS: [ChannelHint, ...ChannelHint[]] = ["email", "linkedin", "sms"];

export const WriteOutputSchema = z.object({
  subject: z.string().optional(),
  body: z.string(),
  channelHint: z.enum(CHANNELS),
});
export type WriteOutput = z.infer<typeof WriteOutputSchema>;

function emojiRule(v: VoiceProfile): string {
  switch (v.emojiUse) {
    case "none":
      return "AUCUN emoji.";
    case "sparing":
      return "Emojis très parcimonieux (0-1 max).";
    case "liberal":
      return "Emojis bienvenus mais maîtrisés : 1–2 qui PONCTUENT le message, jamais un par ligne.";
  }
}

export interface WriteArgs {
  nextObjective: string;
  stage: Stage;
  channelHint: ChannelHint;
  pack: GroundingPack;
  voiceProfile: VoiceProfile;
  forbidden: ForbiddenList;
  persona: string;
  critique?: string; // pour la révision
}

const SYSTEM = [
  "Tu es le RÉDACTEUR de l'agent de recrutement. Tu N'ÉCRIS QUE le message.",
  "Tu ne décides AUCUNE stratégie : l'objectif et l'étape te sont donnés.",
  "Tu ÉVITES ACTIVEMENT la liste d'interdits (sujets bannis, redites, termes proscrits).",
  "Tu n'as PAS le contexte d'entreprise brut : seulement le pack d'ancrage filtré ;",
  "tu dois utiliser ses VALEURS EXACTES pour rester spécifique, jamais générique.",
  "",
  "BARÈME DE REGISTRE — applique STRICTEMENT celui de la formality du message :",
  "- formal : vouvoiement, phrases complètes, zéro contraction familière, zéro emoji.",
  "    Ouverture type « Bonjour [Nom], » ou « Dr. [Nom], ».",
  "- neutral : professionnel mais accessible, vouvoiement par défaut, direct sans raideur.",
  "- casual : chaleureux mais PROPRE — un·e collègue sympa qui écrit vite, JAMAIS ado/texto.",
  "    Autorisé : tutoiement, contractions naturelles ; ouverture « Salut [prénom], » ou « [prénom], ».",
  "    INTERDIT en casual : ouvertures « Yo », « Hey yo », « Wesh », « Coucou » ;",
  "    argot (« ouais », « grave », « chiant », « trop stylé ») ; ponctuation « !!! » / « ??? ».",
  "EMOJI : même en 'liberal', 1–2 emojis qui PONCTUENT, jamais un par ligne.",
  "",
  "Réponds UNIQUEMENT via le tool fourni.",
].join("\n");

function buildUser(args: WriteArgs): string {
  const maxChars = CAPS.maxBodyChars[args.channelHint] ?? 1800;
  const parts = [
    `PERSONA (voix à incarner) : ${args.persona}`,
    `VOIX : formality=${args.voiceProfile.formality}, langue=${args.voiceProfile.language}. ${emojiRule(
      args.voiceProfile,
    )}`,
    args.voiceProfile.styleAdjustments.length
      ? `AJUSTEMENTS DE STYLE (feedback candidat, à appliquer) :\n${args.voiceProfile.styleAdjustments
          .map((s) => `  - ${s}`)
          .join("\n")}`
      : "",
    "",
    `ÉTAPE : ${args.stage}`,
    `OBJECTIF DU MESSAGE : ${args.nextObjective}`,
    `CANAL : ${args.channelHint} (≤ ${maxChars} caractères pour le body${
      args.channelHint === "email" ? " ; fournis aussi un subject" : " ; pas de subject"
    }).`,
    "",
    "PACK D'ANCRAGE (valeurs EXACTES à utiliser — pas d'invention) :",
    ...args.pack.fields.map((f) => `  - ${f.path} = ${f.value}`),
    "",
    "LISTE D'INTERDITS (à éviter activement) :",
    renderForbiddenList(args.forbidden) || "  (aucun)",
  ];
  if (args.critique) {
    parts.push(
      "",
      "RÉVISION DEMANDÉE — la version précédente a échoué la vérification :",
      args.critique,
      "Réécris le message en corrigeant exactement ces points.",
    );
  }
  parts.push(
    "",
    "Écris le message final maintenant (langue = " + args.voiceProfile.language + ").",
  );
  return parts.filter(Boolean).join("\n");
}

export interface WriteResult {
  message: WriteOutput | null;
  ok: boolean;
  error?: string;
  calls: number;
}

export async function runWrite(args: WriteArgs): Promise<WriteResult> {
  const res = await callStructured({
    model: MODELS.write,
    system: SYSTEM,
    user: buildUser(args),
    toolName: "write_message",
    toolDescription: "Rédige le message candidat (subject optionnel, body, channelHint).",
    schema: WriteOutputSchema,
    maxTokens: MAX_TOKENS.write,
    timeoutMs: TIMEOUTS.write,
  });
  if (res.ok) return { message: res.value, ok: true, calls: res.calls };
  return { message: null, ok: false, error: res.error, calls: res.calls };
}

// Fallback déterministe par étape : message safe, court, ancré, jamais d'interdit.
export function fallbackMessage(args: WriteArgs): NextMessage {
  const name =
    args.pack.fields.find((f) => f.path === "identity.name")?.value ?? "notre équipe";
  const role = args.pack.fields.find((f) => f.path.startsWith("hiring.roles"))?.value;

  let body: string;
  switch (args.stage) {
    case "intro":
      body = `Bonjour, je vous contacte de la part de ${name}${
        role ? ` au sujet d'un poste de ${role}` : ""
      }. Seriez-vous ouvert·e à en savoir plus ?`;
      break;
    case "handle_objection":
      body = `Merci pour votre franchise — je comprends votre point. Sans insister, puis-je vous demander ce qui rendrait une opportunité chez ${name} intéressante pour vous ?`;
      break;
    case "propose_call":
    case "confirm_logistics":
      body = `Si cela a du sens pour vous, je serais ravi·e d'organiser un court échange. Quelles seraient vos disponibilités ?`;
      break;
    case "reengage":
      body = `Je me permets un dernier message depuis ${name} : si le moment n'est pas le bon, dites-le-moi simplement et je n'insisterai pas.`;
      break;
    default:
      body = `Bonjour, un mot rapide de la part de ${name} — seriez-vous ouvert·e à un échange ?`;
  }

  return {
    channelHint: args.channelHint,
    ...(args.channelHint === "email" ? { subject: `Un mot de ${name}` } : {}),
    body,
  };
}
