import type { CompanyContext } from "./types";

// A real, opinionated context — PSVIEW describing itself. Used by the
// "Load sample (PSVIEW)" button on /configure so the demo is grounded in
// something true, not lorem.
export const PSVIEW_SAMPLE: CompanyContext = {
  identity: {
    name: "PsView",
    oneLiner:
      "we build autonomous AI agents that engage candidates on a company's behalf — agents that reason and act, not prompt wrappers",
    industry: "AI / recruiting infrastructure",
    sizeStage: "seed-stage startup (Toulouse, France)",
    website: "https://psview.ai",
  },
  culture: {
    values: ["Ownership", "Ship fast", "Candor"],
    cultureNotes:
      "Small founding team. We trust people to own outcomes end-to-end, ship in days not quarters, and tell each other the truth even when it stings. Product sense matters as much as engineering.",
    workStyle: "High-autonomy, low-process, in-person in Toulouse with async depth work",
  },
  hiring: {
    roles: [
      {
        title: "Founding Engineer",
        seniority: "Senior / staff",
        whatTheyllDo:
          "own whole product surfaces end-to-end, from the agent reasoning loop to the UI, and ship them to real customers",
        mustHaveSkills: ["TypeScript", "LLM agent design", "Next.js", "product instinct"],
      },
    ],
    idealCandidateTraits: [
      "thinks in systems",
      "ships fast without being sloppy",
      "argues with evidence",
      "cares about the product, not just the code",
    ],
  },
  voice: {
    tone: "warm and direct",
    formality: "neutral",
    language: "en",
    emojiUse: "sparing",
    dontSay: ["synergy", "rockstar", "ninja", "guru", "disrupt", "10x"],
  },
};
