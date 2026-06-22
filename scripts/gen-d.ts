/**
 * Génère fixtures/D.json (scénario feedback / réversion) de façon déterministe.
 * D = le TOUR 4 : aux tours 2-3 le candidat a rejeté le rôle backend et reproché
 * "trop de jargon" ; au tour 4 il revient dessus. Le priorState encode cet historique
 * avec des ids réels pour que REASON puisse cibler retract/soften.
 *
 *   npx tsx scripts/gen-d.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import type { AgentInput, AgentState, CompanyContext } from "../lib/agent/types";
import { hashContext, deriveVoiceProfile, fallbackPersonality } from "../lib/agent/persona";
import { defaultPlan } from "../lib/agent/state";

const companyContext: CompanyContext = {
  identity: {
    name: "Forgepath",
    oneLiner: "Infrastructure de paiement pour les marketplaces B2B.",
    industry: "Fintech / infrastructure",
    sizeStage: "Series A, 50 personnes",
    website: "https://forgepath.io",
  },
  culture: {
    values: ["fiabilité", "clarté", "autonomie"],
    cultureNotes: "Petites équipes, forte ownership, post-mortems sans blâme.",
    workStyle: "Hybride, 2 jours au bureau.",
  },
  hiring: {
    roles: [
      {
        title: "Senior Backend Engineer",
        seniority: "senior",
        whatTheyllDo: "Construire le moteur de règlement et les APIs de paiement.",
        mustHaveSkills: ["Go", "systèmes distribués", "bases de données"],
      },
      {
        title: "Product Engineer",
        seniority: "senior",
        whatTheyllDo: "Travailler à la frontière produit/backend sur les flux marchands.",
        mustHaveSkills: ["TypeScript", "produit", "APIs"],
      },
    ],
    idealCandidateTraits: ["rigoureux", "orienté impact", "bon communicant"],
  },
  voice: {
    tone: "direct, clair, sans bullshit",
    formality: "neutral",
    language: "français",
    emojiUse: "sparing",
    dontSay: ["disruptif", "rockstar"],
  },
};

const intent = "Recruter un·e ingénieur·e senior, idéalement backend, pour le moteur de paiement.";

const priorState: AgentState = {
  personaKey: hashContext(companyContext),
  personality: fallbackPersonality(companyContext, deriveVoiceProfile(companyContext)),
  plan: { ...defaultPlan(intent), currentStage: "handle_objection" },
  candidateMemory: {
    rejections: [
      {
        id: "rej_t2_0",
        content: "le rôle backend (ne veut pas de poste purement backend)",
        turn: 2,
        status: "active",
        strength: 1,
      },
    ],
    constraints: [],
    objections: [],
    facts: [
      {
        id: "fac_t1_0",
        content: "le candidat travaille surtout en TypeScript aujourd'hui",
        turn: 1,
        status: "active",
        strength: 1,
      },
    ],
    dismissedTopics: [],
    styleFeedback: [
      {
        id: "sty_t2_1",
        content: "éviter le jargon technique, rester simple et concret",
        turn: 2,
        status: "active",
        strength: 1,
      },
    ],
    temperature: "lukewarm",
  },
  agentMemory: {
    pointsMade: [
      "Présenter l'impact du moteur de règlement chez Forgepath",
      "Mettre en avant l'autonomie et les post-mortems sans blâme",
    ],
    questionsAsked: ["Qu'est-ce qui rendrait un prochain rôle intéressant pour vous ?"],
    proposalsMade: [],
  },
  counters: { messagesSent: 3, revisions: 0, objectionsRaised: 1, objectionsResolved: 0 },
};

const input: AgentInput = {
  intent,
  companyContext,
  candidate: { name: "Alex", headline: "Ingénieur·e senior, profil produit/backend" },
  conversation: [
    {
      role: "agent",
      content:
        "Bonjour Alex, je vous contacte de la part de Forgepath. On construit l'infra de paiement pour les marketplaces B2B et on cherche un profil senior pour le moteur de règlement.",
    },
    {
      role: "candidate",
      content:
        "Franchement le backend pur très peu pour moi, et votre message est plein de jargon technique.",
    },
    {
      role: "agent",
      content:
        "Compris, merci de la franchise. Qu'est-ce qui rendrait un prochain rôle intéressant pour vous ?",
    },
  ],
  incomingCandidateReply:
    "En fait, à la réflexion, le backend pourrait m'intéresser si je peux aussi toucher au produit et aux flux marchands.",
  priorState,
};

mkdirSync("fixtures", { recursive: true });
writeFileSync("fixtures/D.json", JSON.stringify(input, null, 2) + "\n");
console.log("fixtures/D.json généré (personaKey =", priorState.personaKey, ")");
