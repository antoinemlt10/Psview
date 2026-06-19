"use client";

import { useState } from "react";

interface ChipInputProps {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}

// Tag/chip input for string[] fields (values, skills, traits, dontSay).
// Enter or comma commits a chip; Backspace on an empty field removes the last.
export function ChipInput({ label, hint, values, onChange, placeholder }: ChipInputProps) {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const v = raw.trim().replace(/,$/, "").trim();
    if (!v) return;
    if (values.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  };

  const remove = (i: number) => onChange(values.filter((_, idx) => idx !== i));

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-ink">{label}</label>
      {hint && <p className="mb-2 text-xs text-muted">{hint}</p>}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-2 transition-colors focus-within:border-ink">
        {values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            className="inline-flex items-center gap-1 rounded-lg border border-line-2 bg-paper-2 px-2 py-1 text-xs font-medium text-ink"
          >
            {v}
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => remove(i)}
              className="rounded text-muted transition-colors hover:text-ink"
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && draft === "" && values.length) {
              remove(values.length - 1);
            }
          }}
          onBlur={() => commit(draft)}
          placeholder={values.length === 0 ? placeholder : ""}
          className="min-w-[8ch] flex-1 bg-transparent px-1 py-0.5 text-sm text-ink outline-none placeholder:text-muted"
        />
      </div>
    </div>
  );
}
