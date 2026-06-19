"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChipInput } from "@/components/ChipInput";
import { SegmentedControl } from "@/components/SegmentedControl";
import { PSVIEW_SAMPLE } from "@/lib/sample";
import { loadContext, saveContext } from "@/lib/storage";
import type { CompanyContext, Role } from "@/lib/types";

const EMPTY_ROLE: Role = {
  title: "",
  seniority: "",
  whatTheyllDo: "",
  mustHaveSkills: [],
};

function emptyContext(): CompanyContext {
  return {
    identity: { name: "", oneLiner: "", industry: "", sizeStage: "", website: "" },
    culture: { values: [], cultureNotes: "", workStyle: "" },
    hiring: { roles: [{ ...EMPTY_ROLE }], idealCandidateTraits: [] },
    voice: { tone: "", formality: "neutral", language: "en", emojiUse: "sparing", dontSay: [] },
  };
}

function Section({
  title,
  step,
  children,
}: {
  title: string;
  step: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-6 shadow-card">
      <div className="mb-6 flex items-baseline gap-3 border-b border-line pb-4">
        <span className="mono text-[11px] uppercase tracking-wide text-muted">{step}</span>
        <h2 className="font-display text-2xl text-ink">{title}</h2>
      </div>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {hint && <span className="mb-2 block text-xs text-muted">{hint}</span>}
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-muted focus:border-ink";

export default function ConfigurePage() {
  const router = useRouter();
  const [ctx, setCtx] = useState<CompanyContext>(emptyContext);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  // Hydrate from any previously saved context.
  useEffect(() => {
    const existing = loadContext();
    if (existing) setCtx(existing);
    setLoaded(true);
  }, []);

  const update = (fn: (draft: CompanyContext) => void) => {
    setCtx((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  };

  const updateRole = (i: number, patch: Partial<Role>) =>
    update((d) => {
      d.hiring.roles[i] = { ...d.hiring.roles[i], ...patch };
    });

  const addRole = () => update((d) => d.hiring.roles.push({ ...EMPTY_ROLE }));
  const removeRole = (i: number) =>
    update((d) => {
      d.hiring.roles.splice(i, 1);
      if (d.hiring.roles.length === 0) d.hiring.roles.push({ ...EMPTY_ROLE });
    });

  const onSave = () => {
    if (!ctx.identity.name.trim()) {
      setError("Company name is required.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setError("");
    saveContext(ctx);
    router.push("/test");
  };

  if (!loaded) {
    return <main className="min-h-screen" />;
  }

  return (
    <main className="min-h-screen pb-24">
      <header className="sticky top-0 z-10 border-b border-line bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3.5">
          <Link href="/" className="font-display text-lg tracking-tight text-ink">
            Ps<span className="text-ink-2">View</span>
          </Link>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCtx(structuredClone(PSVIEW_SAMPLE))}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:border-ink"
            >
              Load sample (PsView)
            </button>
            <button
              type="button"
              onClick={onSave}
              className="rounded-lg bg-ink px-4 py-1.5 text-sm font-semibold text-on-dark transition-transform hover:-translate-y-0.5"
            >
              Save & test →
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-6 pt-12">
        <h1 className="font-display text-4xl text-ink">
          Configure the agent's context
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-2">
          Everything here grounds the agent — its personality, its plan, and every
          message it writes are derived from these fields.
        </p>

        {error && (
          <p
            role="alert"
            className="mt-5 rounded-lg border border-ink bg-paper-2 px-4 py-2.5 text-sm font-medium text-ink"
          >
            {error}
          </p>
        )}

        <div className="mt-8 flex flex-col gap-6">
          {/* IDENTITY */}
          <Section title="Identity" step="01">
            <Field label="Company name" hint="Required.">
              <input
                className={inputCls}
                value={ctx.identity.name}
                onChange={(e) => update((d) => (d.identity.name = e.target.value))}
                placeholder="PsView"
              />
            </Field>
            <Field label="One-liner" hint="What the company does, in one breath.">
              <input
                className={inputCls}
                value={ctx.identity.oneLiner}
                onChange={(e) => update((d) => (d.identity.oneLiner = e.target.value))}
                placeholder="we build autonomous AI recruiting agents"
              />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Industry">
                <input
                  className={inputCls}
                  value={ctx.identity.industry}
                  onChange={(e) => update((d) => (d.identity.industry = e.target.value))}
                  placeholder="AI / recruiting"
                />
              </Field>
              <Field label="Size / stage">
                <input
                  className={inputCls}
                  value={ctx.identity.sizeStage}
                  onChange={(e) => update((d) => (d.identity.sizeStage = e.target.value))}
                  placeholder="seed-stage startup"
                />
              </Field>
            </div>
            <Field label="Website" hint="Optional.">
              <input
                className={inputCls}
                value={ctx.identity.website ?? ""}
                onChange={(e) => update((d) => (d.identity.website = e.target.value))}
                placeholder="https://psview.ai"
              />
            </Field>
          </Section>

          {/* CULTURE */}
          <Section title="Culture" step="02">
            <ChipInput
              label="Values"
              hint="Press Enter or comma to add each."
              values={ctx.culture.values}
              onChange={(values) => update((d) => (d.culture.values = values))}
              placeholder="Ownership, Ship fast, Candor"
            />
            <Field label="Culture notes" hint="How the team actually works.">
              <textarea
                className={`${inputCls} min-h-[90px] resize-y`}
                value={ctx.culture.cultureNotes}
                onChange={(e) => update((d) => (d.culture.cultureNotes = e.target.value))}
                placeholder="Small founding team. We trust people to own outcomes end-to-end…"
              />
            </Field>
            <Field label="Work style" hint="Optional.">
              <input
                className={inputCls}
                value={ctx.culture.workStyle ?? ""}
                onChange={(e) => update((d) => (d.culture.workStyle = e.target.value))}
                placeholder="High-autonomy, in-person in Toulouse with async depth work"
              />
            </Field>
          </Section>

          {/* HIRING */}
          <Section title="Hiring" step="03">
            <div className="flex flex-col gap-4">
              {ctx.hiring.roles.map((role, i) => (
                <div key={i} className="rounded-xl border border-line bg-paper-2 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="mono text-[11px] uppercase tracking-wide text-muted">
                      Role {i + 1}
                    </span>
                    {ctx.hiring.roles.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeRole(i)}
                        className="text-xs font-medium text-muted transition-colors hover:text-ink"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <div className="flex flex-col gap-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Title">
                        <input
                          className={inputCls}
                          value={role.title}
                          onChange={(e) => updateRole(i, { title: e.target.value })}
                          placeholder="Founding Engineer"
                        />
                      </Field>
                      <Field label="Seniority">
                        <input
                          className={inputCls}
                          value={role.seniority}
                          onChange={(e) => updateRole(i, { seniority: e.target.value })}
                          placeholder="Senior / staff"
                        />
                      </Field>
                    </div>
                    <Field label="What they'll do">
                      <textarea
                        className={`${inputCls} min-h-[72px] resize-y`}
                        value={role.whatTheyllDo}
                        onChange={(e) => updateRole(i, { whatTheyllDo: e.target.value })}
                        placeholder="own whole product surfaces end-to-end and ship them to real customers"
                      />
                    </Field>
                    <ChipInput
                      label="Must-have skills"
                      values={role.mustHaveSkills}
                      onChange={(mustHaveSkills) => updateRole(i, { mustHaveSkills })}
                      placeholder="TypeScript, LLM agent design, Next.js"
                    />
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={addRole}
                className="self-start rounded-lg border border-dashed border-line-2 bg-surface px-3.5 py-2 text-sm font-medium text-ink-2 transition-colors hover:border-ink hover:text-ink"
              >
                + Add a role
              </button>
            </div>
            <ChipInput
              label="Ideal candidate traits"
              values={ctx.hiring.idealCandidateTraits}
              onChange={(t) => update((d) => (d.hiring.idealCandidateTraits = t))}
              placeholder="thinks in systems, ships fast, argues with evidence"
            />
          </Section>

          {/* VOICE */}
          <Section title="Voice" step="04">
            <Field label="Tone" hint="The register the agent speaks in — shapes its persona.">
              <input
                className={inputCls}
                value={ctx.voice.tone}
                onChange={(e) => update((d) => (d.voice.tone = e.target.value))}
                placeholder="warm and direct"
              />
            </Field>
            <div className="flex flex-wrap gap-6">
              <SegmentedControl
                label="Formality"
                value={ctx.voice.formality}
                onChange={(formality) => update((d) => (d.voice.formality = formality))}
                options={[
                  { value: "casual", label: "Casual" },
                  { value: "neutral", label: "Neutral" },
                  { value: "formal", label: "Formal" },
                ]}
              />
              <SegmentedControl
                label="Language"
                value={ctx.voice.language}
                onChange={(language) => update((d) => (d.voice.language = language))}
                options={[
                  { value: "en", label: "English" },
                  { value: "fr", label: "Français" },
                ]}
              />
              <SegmentedControl
                label="Emoji use"
                value={ctx.voice.emojiUse}
                onChange={(emojiUse) => update((d) => (d.voice.emojiUse = emojiUse))}
                options={[
                  { value: "none", label: "None" },
                  { value: "sparing", label: "Sparing" },
                  { value: "liberal", label: "Liberal" },
                ]}
              />
            </div>
            <ChipInput
              label="Don't say"
              hint="Words the agent will scrub from every message."
              values={ctx.voice.dontSay ?? []}
              onChange={(dontSay) => update((d) => (d.voice.dontSay = dontSay))}
              placeholder="synergy, rockstar, 10x"
            />
          </Section>
        </div>

        <div className="mt-8 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onSave}
            className="rounded-lg bg-ink px-5 py-2.5 text-sm font-semibold text-on-dark shadow-card transition-transform hover:-translate-y-0.5"
          >
            Save & test →
          </button>
        </div>
      </div>
    </main>
  );
}
