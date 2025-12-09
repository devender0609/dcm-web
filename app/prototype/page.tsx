"use client";

import React, { useState } from "react";

// ---- Types that mirror the form ----
type Sex = "M" | "F";
type Severity = "mild" | "moderate" | "severe";
type CanalRatioCat = "<50%" | "50–60%" | ">60%";
type T2Signal = "none" | "focal" | "multilevel";

type InputState = {
  age: string;
  sex: Sex | "";
  smoker: "0" | "1"; // 0 = non / former, 1 = current
  symptomDurationMonths: string;
  severity: Severity | "";
  baselineMJOA: string;
  levelsOperated: string;
  canalRatio: CanalRatioCat | "";
  t2Signal: T2Signal | "";
  opll: "0" | "1";
  t1Hypo: "0" | "1";
  gaitImpairment: "0" | "1";
  psychDisorder: "0" | "1";
  baselineNDI: string;
  sf36PCS: string;
  sf36MCS: string;
};

type ApproachKey = "anterior" | "posterior" | "circumferential";

type ApproachProbs = {
  anterior: number;
  posterior: number;
  circumferential: number;
};

type UncertaintyLevel = "low" | "moderate" | "high";

type SingleResult = {
  surgeryRecommended: boolean;
  recommendationLabel: string;
  riskScore: number;
  benefitScore: number;
  riskText: string;
  benefitText: string;
  approachProbs: ApproachProbs;
  bestApproach: ApproachKey | "none";
  uncertainty: UncertaintyLevel;
};

// ---- Default starting state (same as your pre-filled example) ----
const initialInputs: InputState = {
  age: "65",
  sex: "M",
  smoker: "0",
  symptomDurationMonths: "12",
  severity: "moderate",
  baselineMJOA: "13",
  levelsOperated: "3",
  canalRatio: "50–60%",
  t2Signal: "multilevel",
  opll: "0",
  t1Hypo: "0",
  gaitImpairment: "1",
  psychDisorder: "0",
  baselineNDI: "40",
  sf36PCS: "40",
  sf36MCS: "45",
};

// -----------------
// Local rule engine
// -----------------
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function computeLocalRecommendation(input: Required<InputState>): SingleResult {
  // Numeric conversions (already validated in handler)
  const age = Number(input.age);
  const dur = Number(input.symptomDurationMonths);
  const mJOA = Number(input.baselineMJOA);
  const levels = Number(input.levelsOperated);
  const ndi = Number(input.baselineNDI);

  // ---- 1) severity from mJOA if not chosen ----
  let severity: Severity = input.severity || "moderate";
  if (!input.severity) {
    if (mJOA >= 15) severity = "mild";
    else if (mJOA >= 12) severity = "moderate";
    else severity = "severe";
  }

  // ---- 2) simple risk/benefit scores on 0–100 ----
  let baseRisk = 10;
  let baseBenefit = 10;

  // severity
  if (severity === "mild") {
    baseRisk += 10;
    baseBenefit += 25;
  } else if (severity === "moderate") {
    baseRisk += 30;
    baseBenefit += 45;
  } else {
    baseRisk += 55;
    baseBenefit += 55;
  }

  // duration
  if (dur >= 24) {
    baseRisk += 10;
  } else if (dur >= 6) {
    baseRisk += 5;
  }

  // imaging
  if (input.t2Signal === "focal") baseRisk += 5;
  if (input.t2Signal === "multilevel") baseRisk += 10;
  if (input.canalRatio === "50–60%") baseRisk += 5;
  if (input.canalRatio === ">60%") baseRisk += 10;
  if (input.opll === "1") baseRisk += 5;
  if (input.t1Hypo === "1") baseRisk += 5;

  // clinical risk markers
  if (input.gaitImpairment === "1") baseRisk += 5;
  if (age >= 70) baseRisk += 5;

  // expected benefit knobs
  if (mJOA <= 14) baseBenefit += 10;
  if (ndi >= 30) baseBenefit += 5;
  if (age <= 75) baseBenefit += 5;

  const riskScore = Math.max(0, Math.min(100, baseRisk));
  const benefitScore = Math.max(0, Math.min(100, baseBenefit));

  const riskText =
    riskScore >= 70
      ? "High risk of neurological worsening or failure to improve without surgery."
      : riskScore >= 40
      ? "Moderate risk of neurological worsening or failure to improve without surgery."
      : "Lower short-term risk of clear neurological worsening, but progression remains possible.";

  const benefitText =
    benefitScore >= 70
      ? "High estimated chance of clinically meaningful mJOA and functional improvement with surgery."
      : benefitScore >= 40
      ? "Moderate chance of clinically meaningful improvement with surgery."
      : "Lower modeled chance of large mJOA change; surgery may still help pain or stability in selected patients.";

  // ---- 3) surgery recommendation ----
  let surgeryRecommended = false;
  let recommendationLabel = "Non-operative trial reasonable";

  if (severity === "severe") {
    surgeryRecommended = true;
    recommendationLabel = "Surgery recommended";
  } else if (severity === "moderate" && (riskScore >= 40 || benefitScore >= 40)) {
    surgeryRecommended = true;
    recommendationLabel = "Surgery recommended";
  } else if (
    severity === "mild" &&
    (input.t2Signal === "multilevel" ||
      input.canalRatio === ">60%" ||
      input.gaitImpairment === "1")
  ) {
    surgeryRecommended = true;
    recommendationLabel = "Consider surgery";
  } else {
    surgeryRecommended = false;
    recommendationLabel = "Non-operative trial reasonable";
  }

  // ---- 4) approach probabilities (heuristic) ----
  let approach: ApproachProbs = {
    anterior: 0.33,
    posterior: 0.34,
    circumferential: 0.33,
  };

  // simple patterns: multilevel + OPLL → posterior leaning, focal + high COR → anterior leaning
  if (input.t2Signal === "multilevel" || levels >= 3 || input.opll === "1") {
    approach = { anterior: 0.2, posterior: 0.6, circumferential: 0.2 };
  } else if (input.t2Signal === "focal" && (input.canalRatio === ">60%" || levels <= 2)) {
    approach = { anterior: 0.55, posterior: 0.25, circumferential: 0.2 };
  } else if (severity === "severe" && levels >= 3 && input.canalRatio === ">60%") {
    approach = { anterior: 0.25, posterior: 0.45, circumferential: 0.3 };
  }

  const vals: [ApproachKey, number][] = [
    ["anterior", approach.anterior],
    ["posterior", approach.posterior],
    ["circumferential", approach.circumferential],
  ];

  // normalize + pick best
  const sum = vals.reduce((s, [, v]) => s + v, 0) || 1;
  const norm: ApproachProbs = {
    anterior: approach.anterior / sum,
    posterior: approach.posterior / sum,
    circumferential: approach.circumferential / sum,
  };

  const sorted = [...(Object.entries(norm) as [ApproachKey, number][])].sort(
    (a, b) => b[1] - a[1]
  );
  const best = sorted[0][0];
  const bestP = sorted[0][1];
  const secondP = sorted[1][1];

  const diff = bestP - secondP;
  const uncertainty: UncertaintyLevel =
    diff >= 0.15 ? "low" : diff >= 0.05 ? "moderate" : "high";

  return {
    surgeryRecommended,
    recommendationLabel,
    riskScore,
    benefitScore,
    riskText,
    benefitText,
    approachProbs: norm,
    bestApproach: best,
    uncertainty,
  };
}

// ---------------
// React component
// ---------------
export default function PrototypePage() {
  const [tab, setTab] = useState<"single" | "batch">("single");
  const [inputs, setInputs] = useState<InputState>(initialInputs);
  const [result, setResult] = useState<SingleResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // helper to update fields
  function updateField<K extends keyof InputState>(key: K, value: InputState[K]) {
    setInputs((prev) => ({ ...prev, [key]: value }));
  }

  // reset back to blank (per your request)
  function handleReset() {
    setInputs({
      age: "",
      sex: "",
      smoker: "0",
      symptomDurationMonths: "",
      severity: "",
      baselineMJOA: "",
      levelsOperated: "",
      canalRatio: "",
      t2Signal: "",
      opll: "0",
      t1Hypo: "0",
      gaitImpairment: "0",
      psychDisorder: "0",
      baselineNDI: "",
      sf36PCS: "",
      sf36MCS: "",
    });
    setResult(null);
    setError(null);
  }

  async function handleRunSingle() {
    setError(null);

    // ---- validation + parsing ----
    const requiredNumeric: (keyof InputState)[] = [
      "age",
      "symptomDurationMonths",
      "baselineMJOA",
      "levelsOperated",
      "baselineNDI",
      "sf36PCS",
      "sf36MCS",
    ];

    for (const k of requiredNumeric) {
      const v = inputs[k];
      if (v === "" || v === null) {
        setError("Please fill in all numeric fields before running the recommendation.");
        return;
      }
      const num = Number(v as string);
      if (Number.isNaN(num) || num < 0) {
        setError("Numeric fields must be non-negative numbers.");
        return;
      }
    }

    if (!inputs.sex || !inputs.canalRatio || !inputs.t2Signal) {
      setError("Please select sex, canal occupying ratio, and T2 cord signal.");
      return;
    }

    setLoading(true);
    try {
      const apiBase = process.env.NEXT_PUBLIC_DCM_API_URL;

      if (apiBase) {
        // ---------- API path (for future deployment of FastAPI) ----------
        const payload = {
          age: Number(inputs.age),
          sex: inputs.sex,
          smoker: Number(inputs.smoker),
          symptom_duration_months: Number(inputs.symptomDurationMonths),
          severity: inputs.severity || "moderate",
          baseline_mJOA: Number(inputs.baselineMJOA),
          levels_operated: Number(inputs.levelsOperated),
          OPLL: Number(inputs.opll),
          canal_occupying_ratio_cat: inputs.canalRatio,
          T2_signal: inputs.t2Signal,
          T1_hypointensity: Number(inputs.t1Hypo),
          gait_impairment: Number(inputs.gaitImpairment),
          psych_disorder: Number(inputs.psychDisorder),
          baseline_NDI: Number(inputs.baselineNDI),
          baseline_SF36_PCS: Number(inputs.sf36PCS),
          baseline_SF36_MCS: Number(inputs.sf36MCS),
        };

        const resp = await fetch(`${apiBase}/recommend_single`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`API error (${resp.status}): ${text}`);
        }

        const data = await resp.json();

        // minimal mapping – assumes your FastAPI returns fields similar
        const mapped: SingleResult = {
          surgeryRecommended: Boolean(data.surgery_recommended),
          recommendationLabel: data.recommendation_label ?? "Recommendation",
          riskScore: data.risk_score ?? 0,
          benefitScore: data.benefit_score ?? 0,
          riskText:
            data.risk_text ??
            "Risk of neurological worsening or failure to improve without surgery.",
          benefitText:
            data.benefit_text ??
            "Estimated chance of clinically meaningful mJOA improvement with surgery.",
          approachProbs: {
            anterior: data.approach_probs?.anterior ?? 0.33,
            posterior: data.approach_probs?.posterior ?? 0.34,
            circumferential: data.approach_probs?.circumferential ?? 0.33,
          },
          bestApproach: (data.best_approach as ApproachKey) ?? "posterior",
          uncertainty: (data.uncertainty_level as UncertaintyLevel) ?? "moderate",
        };

        setResult(mapped);
      } else {
        // ---------- local, frozen TS logic (for Vercel) ----------
        const localInputs: Required<InputState> = {
          ...(inputs as InputState),
          age: inputs.age || "0",
          symptomDurationMonths: inputs.symptomDurationMonths || "0",
          baselineMJOA: inputs.baselineMJOA || "0",
          levelsOperated: inputs.levelsOperated || "0",
          baselineNDI: inputs.baselineNDI || "0",
          sf36PCS: inputs.sf36PCS || "0",
          sf36MCS: inputs.sf36MCS || "0",
          sex: inputs.sex || "M",
          severity: (inputs.severity || "moderate") as Severity,
          canalRatio: (inputs.canalRatio || "50–60%") as CanalRatioCat,
          t2Signal: (inputs.t2Signal || "none") as T2Signal,
        };

        const res = computeLocalRecommendation(localInputs);
        setResult(res);
      }
    } catch (e: any) {
      console.error(e);
      setError(e.message ?? "Failed to generate recommendation.");
    } finally {
      setLoading(false);
    }
  }

  // small helpers for rendering
  function formatPct(p: number): string {
    return `${Math.round(clamp01(p) * 100)}%`;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <img
              src="/ascension-seton-logo.png"
              alt="Ascension Texas & Seton"
              className="h-10 w-auto object-contain"
            />
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold">
              Ascension Texas Spine and Scoliosis
            </div>
            <div className="text-xs text-slate-500">
              Degenerative Cervical Myelopathy Decision-Support Tool
            </div>
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="mx-auto max-w-6xl px-6 py-8 space-y-6">
        {/* Tabs */}
        <div className="inline-flex rounded-full bg-slate-100 p-1 text-sm">
          <button
            type="button"
            onClick={() => setTab("single")}
            className={`rounded-full px-4 py-2 ${
              tab === "single"
                ? "bg-white font-semibold text-emerald-700 shadow-sm"
                : "text-slate-600"
            }`}
          >
            Single patient
          </button>
          <button
            type="button"
            onClick={() => setTab("batch")}
            className={`rounded-full px-4 py-2 ${
              tab === "batch"
                ? "bg-white font-semibold text-emerald-700 shadow-sm"
                : "text-slate-600"
            }`}
          >
            Batch (CSV)
          </button>
        </div>

        {tab === "single" ? (
          <>
            {/* Grid: left inputs, right explanation */}
            <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)]">
              {/* Left: inputs */}
              <section className="rounded-2xl bg-white p-6 shadow-sm">
                <h2 className="mb-4 text-lg font-semibold text-slate-900">
                  1. Patient inputs
                </h2>

                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 text-sm">
                  {/* Age */}
                  <div>
                    <label className="mb-1 block font-medium">Age (years)</label>
                    <input
                      type="number"
                      min={0}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.age}
                      onChange={(e) => updateField("age", e.target.value)}
                    />
                  </div>

                  {/* Sex */}
                  <div>
                    <label className="mb-1 block font-medium">Sex</label>
                    <select
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.sex}
                      onChange={(e) => updateField("sex", e.target.value as Sex | "")}
                    >
                      <option value="">Select</option>
                      <option value="M">Male</option>
                      <option value="F">Female</option>
                    </select>
                  </div>

                  {/* Smoker */}
                  <div>
                    <label className="mb-1 block font-medium">Smoking status</label>
                    <select
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.smoker}
                      onChange={(e) => updateField("smoker", e.target.value as "0" | "1")}
                    >
                      <option value="0">Non-smoker / former</option>
                      <option value="1">Current smoker</option>
                    </select>
                  </div>

                  {/* Symptom duration */}
                  <div>
                    <label className="mb-1 block font-medium">
                      Symptom duration (months)
                    </label>
                    <input
                      type="number"
                      min={0}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.symptomDurationMonths}
                      onChange={(e) =>
                        updateField("symptomDurationMonths", e.target.value)
                      }
                    />
                  </div>

                  {/* mJOA */}
                  <div>
                    <label className="mb-1 block font-medium">mJOA</label>
                    <input
                      type="number"
                      min={0}
                      max={18}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.baselineMJOA}
                      onChange={(e) => updateField("baselineMJOA", e.target.value)}
                    />
                  </div>

                  {/* mJOA-derived severity (optional override) */}
                  <div>
                    <label className="mb-1 block font-medium">Severity (auto from mJOA)</label>
                    <select
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.severity}
                      onChange={(e) =>
                        updateField("severity", e.target.value as Severity | "")
                      }
                    >
                      <option value="">Auto</option>
                      <option value="mild">Mild (mJOA ≥15)</option>
                      <option value="moderate">Moderate (mJOA 12–14)</option>
                      <option value="severe">Severe (mJOA &lt;12)</option>
                    </select>
                  </div>

                  {/* Canal ratio */}
                  <div>
                    <label className="mb-1 block font-medium">Canal occupying ratio</label>
                    <select
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.canalRatio}
                      onChange={(e) =>
                        updateField("canalRatio", e.target.value as CanalRatioCat | "")
                      }
                    >
                      <option value="">Select</option>
                      <option value="<50%">&lt;50%</option>
                      <option value="50–60%">50–60%</option>
                      <option value=">60%">&gt;60%</option>
                    </select>
                  </div>

                  {/* T2 signal */}
                  <div>
                    <label className="mb-1 block font-medium">T2 cord signal</label>
                    <select
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.t2Signal}
                      onChange={(e) =>
                        updateField("t2Signal", e.target.value as T2Signal | "")
                      }
                    >
                      <option value="">Select</option>
                      <option value="none">None</option>
                      <option value="focal">Focal</option>
                      <option value="multilevel">Multilevel / extensive</option>
                    </select>
                  </div>

                  {/* Levels operated */}
                  <div>
                    <label className="mb-1 block font-medium">
                      Planned operated levels
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.levelsOperated}
                      onChange={(e) => updateField("levelsOperated", e.target.value)}
                    />
                  </div>

                  {/* OPLL */}
                  <div>
                    <label className="mb-1 block font-medium">OPLL present</label>
                    <select
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.opll}
                      onChange={(e) => updateField("opll", e.target.value as "0" | "1")}
                    >
                      <option value="0">No</option>
                      <option value="1">Yes</option>
                    </select>
                  </div>

                  {/* T1 hypo */}
                  <div>
                    <label className="mb-1 block font-medium">T1 hypointensity</label>
                    <select
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.t1Hypo}
                      onChange={(e) =>
                        updateField("t1Hypo", e.target.value as "0" | "1")
                      }
                    >
                      <option value="0">No</option>
                      <option value="1">Yes</option>
                    </select>
                  </div>

                  {/* Gait impairment */}
                  <div>
                    <label className="mb-1 block font-medium">Gait impairment</label>
                    <select
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.gaitImpairment}
                      onChange={(e) =>
                        updateField("gaitImpairment", e.target.value as "0" | "1")
                      }
                    >
                      <option value="0">No</option>
                      <option value="1">Yes</option>
                    </select>
                  </div>

                  {/* Psych disorder */}
                  <div>
                    <label className="mb-1 block font-medium">Psychiatric disorder</label>
                    <select
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.psychDisorder}
                      onChange={(e) =>
                        updateField("psychDisorder", e.target.value as "0" | "1")
                      }
                    >
                      <option value="0">No</option>
                      <option value="1">Yes</option>
                    </select>
                  </div>

                  {/* NDI */}
                  <div>
                    <label className="mb-1 block font-medium">Baseline NDI</label>
                    <input
                      type="number"
                      min={0}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.baselineNDI}
                      onChange={(e) => updateField("baselineNDI", e.target.value)}
                    />
                  </div>

                  {/* SF-36 PCS */}
                  <div>
                    <label className="mb-1 block font-medium">SF-36 PCS</label>
                    <input
                      type="number"
                      min={0}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.sf36PCS}
                      onChange={(e) => updateField("sf36PCS", e.target.value)}
                    />
                  </div>

                  {/* SF-36 MCS */}
                  <div>
                    <label className="mb-1 block font-medium">SF-36 MCS</label>
                    <input
                      type="number"
                      min={0}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.sf36MCS}
                      onChange={(e) => updateField("sf36MCS", e.target.value)}
                    />
                  </div>
                </div>

                {/* Buttons + error */}
                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleRunSingle}
                    disabled={loading}
                    className="rounded-full bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
                  >
                    {loading ? "Running..." : "Run recommendation"}
                  </button>
                  <button
                    type="button"
                    onClick={handleReset}
                    className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Reset
                  </button>
                  {error && (
                    <div className="text-sm text-red-600">
                      {error}
                    </div>
                  )}
                </div>
              </section>

              {/* Right: guidance cards */}
              <section className="space-y-4">
                <div className="rounded-2xl bg-white p-5 shadow-sm">
                  <h3 className="mb-2 text-base font-semibold text-emerald-700">
                    1. Should this patient undergo surgery?
                  </h3>
                  <p className="text-sm text-slate-700">
                    Run a single-patient recommendation to see surgery vs non-operative
                    probabilities, risk bands, and expected benefit. The model uses
                    mJOA-based severity, symptom duration, MRI cord signal, canal compromise,
                    OPLL, gait impairment, and age.
                  </p>
                </div>

                <div className="rounded-2xl bg-white p-5 shadow-sm">
                  <h3 className="mb-2 text-base font-semibold text-sky-700">
                    2. If surgery is offered, which approach?
                  </h3>
                  <p className="text-sm text-slate-700">
                    The tool compares estimated probabilities of achieving clinically
                    meaningful mJOA improvement (MCID) with anterior, posterior, and
                    circumferential procedures.{" "}
                    <span className="font-medium">Uncertainty</span> reflects how close
                    these probabilities are to each other:{" "}
                    <span className="font-medium">low</span> = one clear favorite,{" "}
                    <span className="font-medium">high</span> = several similar options,
                    where surgeon preferences, alignment, and comorbidities may drive the
                    final choice.
                  </p>
                </div>
              </section>
            </div>

            {/* Result panels */}
            {result && (
              <div className="space-y-6">
                {/* Surgery decision */}
                <section className="rounded-2xl bg-white p-6 shadow-sm">
                  <h2 className="mb-3 text-lg font-semibold text-slate-900">
                    1. Should this patient undergo surgery?
                  </h2>
                  <div className="mb-2 text-sm">
                    <span className="font-semibold">Recommendation: </span>
                    <span
                      className={
                        result.surgeryRecommended
                          ? "font-semibold text-emerald-700"
                          : "font-semibold text-slate-800"
                      }
                    >
                      {result.recommendationLabel}
                    </span>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2 text-sm">
                    <div>
                      <div className="mb-1 font-medium">Risk without surgery</div>
                      <div className="mb-1 text-slate-700">{result.riskText}</div>
                      <div className="mt-2 h-3 w-full rounded-full bg-rose-100">
                        <div
                          className="h-3 rounded-full bg-rose-500"
                          style={{ width: `${result.riskScore}%` }}
                        />
                      </div>
                      <div className="mt-1 text-xs text-rose-700">
                        Risk of neurological worsening / failure to improve:{" "}
                        {result.riskScore.toFixed(0)}%
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 font-medium">
                        Expected chance of meaningful improvement with surgery
                      </div>
                      <div className="mb-1 text-slate-700">{result.benefitText}</div>
                      <div className="mt-2 h-3 w-full rounded-full bg-emerald-100">
                        <div
                          className="h-3 rounded-full bg-emerald-500"
                          style={{ width: `${result.benefitScore}%` }}
                        />
                      </div>
                      <div className="mt-1 text-xs text-emerald-700">
                        Estimated probability of mJOA MCID or comparable functional
                        improvement: {result.benefitScore.toFixed(0)}%
                      </div>
                    </div>
                  </div>
                </section>

                {/* Approach choice */}
                <section className="rounded-2xl bg-white p-6 shadow-sm">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-slate-900">
                      2. If surgery is offered, which approach?
                    </h2>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                      Uncertainty:{" "}
                      <span className="capitalize">{result.uncertainty}</span>
                    </span>
                  </div>

                  <div className="grid gap-4 md:grid-cols-3 text-sm">
                    {(["anterior", "posterior", "circumferential"] as ApproachKey[]).map(
                      (key) => {
                        const pct = formatPct(result.approachProbs[key]);
                        const isBest = result.bestApproach === key;
                        const label =
                          key === "anterior"
                            ? "ANTERIOR"
                            : key === "posterior"
                            ? "POSTERIOR"
                            : "CIRCUMFERENTIAL";
                        const subtitle = isBest
                          ? "Highest estimated chance of clinically meaningful improvement."
                          : "Lower modeled probability compared with the leading approach.";
                        return (
                          <div
                            key={key}
                            className={`rounded-2xl border px-4 py-3 ${
                              isBest
                                ? "border-emerald-500 bg-emerald-50"
                                : "border-slate-200 bg-slate-50"
                            }`}
                          >
                            <div className="text-xs font-semibold text-slate-500">
                              {label}
                            </div>
                            <div className="mt-1 text-2xl font-semibold text-slate-900">
                              {pct}
                            </div>
                            <div className="mt-1 text-xs text-slate-600">
                              {subtitle}
                            </div>
                          </div>
                        );
                      }
                    )}
                  </div>

                  <div className="mt-4 text-xs text-slate-500">
                    Patterns are derived from guideline-informed logic and synthetic
                    outcome data and are intended to support, not replace, surgeon
                    judgment. Exact probabilities will be recalibrated once real Ascension
                    Texas outcome data are available.
                  </div>
                </section>
              </div>
            )}

            {/* Bottom info card */}
            <section className="rounded-2xl bg-white p-5 text-xs text-slate-600 shadow-sm">
              <div className="mb-1 font-semibold">
                Hybrid guideline + ML engine (development phase)
              </div>
              <p>
                This prototype blends AO Spine / WFNS guideline concepts (myelopathy
                severity, cord signal, canal compromise, OPLL, gait) with patterns learned
                from large synthetic DCM outcome cohorts. The underlying model is frozen
                for this version; it does not learn continuously from use. It is intended
                to structure discussions and document reasoning, not to mandate treatment.
              </p>
            </section>
          </>
        ) : (
          // --------- Batch tab (layout kept simple, you can extend later) ----------
          <section className="rounded-2xl bg-white p-6 text-sm shadow-sm">
            <h2 className="mb-3 text-lg font-semibold text-slate-900">
              Batch (CSV) – coming next
            </h2>
            <p className="text-slate-700">
              This tab will allow you to upload a CSV of patients and export aggregated
              recommendations. For now, please use the single-patient view while we finish
              wiring the batch logic to the same frozen model.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
