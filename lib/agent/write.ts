import { z } from "zod";
import type { ChannelHint, NextMessage, Stage, VoiceProfile } from "./types";
import type { GroundingPack, ForbiddenList } from "./grounding";
import { renderForbiddenList } from "./grounding";
import { callStructured } from "./llm";
import { MODELS, MAX_TOKENS, TIMEOUTS } from "./config";

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
  decision: string; // la décision complète de REASON — à EXÉCUTER
  mustDo: string[]; // directives DO de ce tour
  mustNotDo: string[]; // directives DON'T de ce tour
  schedulingAllowed: boolean; // proposition d'appel/créneau autorisée ce tour ?
  stage: Stage;
  channelHint: ChannelHint;
  pack: GroundingPack;
  voiceProfile: VoiceProfile;
  forbidden: ForbiddenList;
  persona: string;
  candidateName?: string; // prénom réel du candidat, pour la salutation
  bodyLimit: number; // limite DURE de caractères du body
  critique?: string; // pour la révision
}

const SYSTEM = [
  "Tu es le RÉDACTEUR de l'agent de recrutement. Tu N'ÉCRIS QUE le message.",
  "Tu EXÉCUTES la DÉCISION qu'on te donne — tu n'improvises PAS et tu n'ajoutes RIEN",
  "qui n'est pas demandé. Fais exactement ce qui est dans À FAIRE, évite tout ce qui est",
  "dans À NE PAS FAIRE. Si une idée n'est ni demandée ni interdite, dans le doute ABSTIENS-toi.",
  "Tu ne connais PAS l'objectif global de la campagne (ex: « décrocher un appel/meeting ») :",
  "ce n'est pas ton rôle de faire avancer le funnel. Le planner décide quand proposer un appel ;",
  "toi, tu rends UNIQUEMENT le message de ce tour. N'avance JAMAIS de toi-même vers un rendez-vous.",
  "Tu ÉVITES ACTIVEMENT la liste d'interdits (sujets bannis, redites, termes proscrits).",
  "Tu n'as PAS le contexte d'entreprise brut : seulement le pack d'ancrage filtré ;",
  "tu dois utiliser ses VALEURS EXACTES pour rester spécifique, jamais générique.",
  "",
  "SCHEDULING : si la proposition d'appel n'est PAS autorisée ce tour, n'évoque NI appel,",
  "NI créneau, NI horaire, NI jour, NI lien d'agenda. Réponds au fond sans pousser de rendez-vous.",
  "",
  "LONGUEUR (CONTRAINTE DURE) : le body NE DOIT PAS dépasser la limite indiquée.",
  "Priorise l'essentiel, coupe le secondaire, reste sous la limite. Mieux vaut court et net.",
  "",
  "PLACEHOLDERS STRICTEMENT INTERDITS : n'écris JAMAIS de crochets [ … ] ni de gabarit",
  "type [First Name], [Your Name], [Company], [rôle]. Si une info manque, reformule sans elle.",
  "SALUTATION : utilise le PRÉNOM du candidat s'il est fourni ; sinon n'utilise AUCUN nom",
  "(ouverture sans nom), surtout pas un nom inventé ni un placeholder.",
  "SIGNATURE : signe avec le nom du persona s'il en a un ; sinon NE SIGNE PAS du tout.",
  "",
  "BARÈME DE REGISTRE — applique STRICTEMENT celui de la formality du message :",
  "- formal : vouvoiement, phrases complètes, zéro contraction familière, zéro emoji.",
  "    Ouverture : « Bonjour » suivi du prénom du candidat (ou « Bonjour, » sans nom).",
  "- neutral : professionnel mais accessible, vouvoiement par défaut, direct sans raideur.",
  "- casual : chaleureux mais PROPRE — un·e collègue sympa qui écrit vite, JAMAIS ado/texto.",
  "    Autorisé : tutoiement, contractions naturelles ; ouverture « Salut » + prénom (ou sans nom).",
  "    INTERDIT en casual : ouvertures « Yo », « Hey yo », « Wesh », « Coucou » ;",
  "    argot (« ouais », « grave », « chiant », « trop stylé ») ; ponctuation « !!! » / « ??? ».",
  "EMOJI : même en 'liberal', 1–2 emojis qui PONCTUENT, jamais un par ligne.",
  "",
  "FORMALITÉ = PLANCHER, jamais mirrorée depuis le candidat. Le niveau de formalité",
  "est FIXE (celui indiqué). Même si le candidat écrit très relâché (« lol », « mec »,",
  "emojis, fautes), tu NE descends JAMAIS sous ce niveau : un candidat familier ne te",
  "fait pas passer en tutoiement si la formalité est 'formal'/'neutral'. Le seul effet",
  "autorisé du registre candidat est de moduler la CHALEUR DANS la bande de formalité",
  "(plus chaleureux, jamais moins formel). 'formal' reste formel-chaleureux.",
  "",
  "LANGUE = tout le message dans la langue active (salutation + corps + signature).",
  "JAMAIS de mélange : pas de « Bonjour » + corps en anglais + « Alex » en signature.",
  "",
  "Réponds UNIQUEMENT via le tool fourni.",
].join("\n");

function buildUser(args: WriteArgs): string {
  const parts = [
    `PERSONA (voix à incarner) : ${args.persona}`,
    `VOIX : formality=${args.voiceProfile.formality}, langue=${args.voiceProfile.language}. ${emojiRule(
      args.voiceProfile,
    )}`,
    args.candidateName
      ? `PRÉNOM CANDIDAT : ${args.candidateName} (à utiliser dans la salutation).`
      : "PRÉNOM CANDIDAT : inconnu — n'utilise AUCUN nom (jamais de placeholder type [First Name]).",
    args.voiceProfile.styleAdjustments.length
      ? `AJUSTEMENTS DE STYLE (feedback candidat — modulent la CHALEUR seulement,\nJAMAIS la formalité sous le plancher « ${args.voiceProfile.formality} ») :\n${args.voiceProfile.styleAdjustments
          .map((s) => `  - ${s}`)
          .join("\n")}`
      : "",
    "",
    `ÉTAPE : ${args.stage}`,
    args.stage === "intro"
      ? [
          "POSTURE D'OUVERTURE (contact FROID, aucune interaction préalable) — NON PRÉSOMPTUEUSE :",
          "  - Ne présume RIEN sur l'intention du candidat. Il NE cherche PAS forcément à bouger.",
          "  - INTERDIT : « le type de travail que vous voulez faire », « votre prochain poste »,",
          "    « ce que vous recherchez », ou toute formule supposant une évaluation/recherche en cours.",
          "  - Posture = présenter brièvement + inviter la curiosité, sans rien supposer.",
          "  - Question d'ouverture du type « est-ce que ça vaut un coup d'œil ? » ou « plutôt en",
          "    recherche active, ou vous gardez juste un œil ouvert ? » — PAS une question qui suppose",
          "    qu'il évalue déjà des opportunités.",
        ].join("\n")
      : "",
    `DÉCISION À EXÉCUTER (ne dévie pas) : ${args.decision}`,
    `OBJECTIF : ${args.nextObjective}`,
    args.mustDo.length
      ? `À FAIRE ce tour-ci (exécute CHAQUE point) :\n${args.mustDo.map((s) => `  - ${s}`).join("\n")}`
      : "",
    args.mustNotDo.length
      ? `À NE PAS FAIRE ce tour-ci (interdits DURS) :\n${args.mustNotDo.map((s) => `  - ${s}`).join("\n")}`
      : "",
    args.schedulingAllowed
      ? "SCHEDULING : autorisé ce tour (tu peux proposer un échange/créneau)."
      : "SCHEDULING : INTERDIT ce tour — aucun appel, créneau, horaire, jour ni lien d'agenda.",
    `CANAL : ${args.channelHint} — body ≤ ${args.bodyLimit} caractères (CONTRAINTE DURE : priorise, ne dépasse pas)${
      args.channelHint === "email" ? " ; fournis aussi un subject" : " ; pas de subject"
    }.`,
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
      "Réécris le message en corrigeant exactement ces points (et reste sous la limite).",
    );
  }
  parts.push(
    "",
    `Écris le message final maintenant, en ${args.voiceProfile.language}, sous ${args.bodyLimit} caractères, sans aucun placeholder.`,
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

// Troncature propre à la frontière de phrase (utilisée par la réparation déterministe).
export function truncateToSentence(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const sentenceEnd = slice.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (sentenceEnd && sentenceEnd[0].trim().length >= Math.min(60, Math.floor(limit * 0.4))) {
    return sentenceEnd[0].trim();
  }
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim() + "…";
}

// Normalise une langue active en bucket de template ("fr" par défaut sinon "en").
export function fallbackLang(language: string): "fr" | "en" {
  return /^fr|fran[cç]/i.test(language) ? "fr" : "en";
}

// Fallback déterministe par étape : message safe, court, ancré, dans l'ACTIVE LANGUAGE,
// et CONTEXT-AWARE — jamais de ré-introduction quand on est en milieu de conversation.
export function fallbackMessage(args: WriteArgs): NextMessage {
  const fr = fallbackLang(args.voiceProfile.language) === "fr";
  const name = args.pack.fields.find((f) => f.path === "identity.name")?.value ?? (fr ? "notre équipe" : "our team");
  const role = args.pack.fields.find((f) => f.path.startsWith("hiring.roles"))?.value;
  const roleClause = role ? (fr ? `le poste de ${role}` : `the ${role} role`) : fr ? "ce rôle" : "this role";

  let body: string;
  switch (args.stage) {
    case "intro":
      body = fr
        ? `Bonjour, je vous contacte de la part de ${name}${role ? ` au sujet de ${roleClause}` : ""}. Seriez-vous ouvert à en savoir plus ?`
        : `Hi, I'm reaching out from ${name}${role ? ` about ${roleClause}` : ""}. Would you be open to hearing a bit more?`;
      break;
    case "handle_objection":
      body = fr
        ? `Merci pour votre franchise, je comprends. Sans insister : qu'est-ce qui rendrait une opportunité chez ${name} intéressante pour vous ?`
        : `Thanks for being straight with me — I understand. Without pushing: what would make an opportunity at ${name} worth it for you?`;
      break;
    case "propose_call":
    case "confirm_logistics":
      body = fr
        ? `Si ça a du sens pour vous, je serais ravi d'organiser un court échange. Quelles seraient vos disponibilités ?`
        : `If it makes sense for you, I'd be glad to set up a short call. What does your availability look like?`;
      break;
    case "reengage":
      body = fr
        ? `Un dernier mot de la part de ${name} : si le moment n'est pas le bon, dites-le-moi simplement et je n'insisterai pas.`
        : `One last note from ${name}: if the timing isn't right, just tell me and I won't push.`;
      break;
    default: // value_pitch et autres milieux de conversation : court, on-topic, pas de ré-intro
      body = fr
        ? `Pour rebondir : ce qui rend ${roleClause} chez ${name} pertinent, c'est l'impact concret et l'autonomie. Qu'est-ce qui compte le plus pour vous ?`
        : `Picking up where we were: what makes ${roleClause} at ${name} worth a look is the real impact and ownership. What matters most to you?`;
  }

  return {
    channelHint: args.channelHint,
    ...(args.channelHint === "email"
      ? { subject: fr ? `Un mot de ${name}` : `A note from ${name}` }
      : {}),
    body,
  };
}
