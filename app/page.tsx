"use client";

import React, { useState } from "react";

/**
 * TYPES
 */

type Severity = "mild" | "moderate" | "severe";
type SmokingStatus = "never" | "former" | "current";

type T2Signal = "none" | "focal" | "multilevel";
type CanalRatio = "<50%" | "50-60%" | ">60%";

type ApproachKey = "anterior" | "posterior" | "circumferential";

type SingleInput = {
  age: number | "";
  sex: "M" | "F";
  smokingStatus: SmokingStatus;
  symptomDurationMonths: number | "";
  severity: Severity;
  baseline_mJOA: number | "";
  plannedLevels: number | "";
  opp: 0 | 1; // OPLL: 0 = no, 1 = yes
  canalRatio: CanalRatio;
  t2Signal: T2Signal;
  t1Hypo: 0 | 1;
  gaitImpairment: 0 | 1;
  psychDisorder: 0 | 1;
  baseline_NDI: number | "";
  baseline_SF36_PCS: number | "";
  baseline_SF36_MCS: number | "";
};

type ApproachProbs = Record<ApproachKey, number>;

type SingleResult = {
  normalizedInput: SingleInput;
  pSurgeryRule: number;
  pSurgeryHybrid: number;
  pMCID: number;
  surgeryRecommended: boolean;
  recommendationLabel: string;
  riskScore: number;
  benefitScore: number;
  riskText: string;
  benefitText: string;
  approachProbs: ApproachProbs;
  bestApproach: ApproachKey;
  secondBestApproach: ApproachKey;
  uncertaintyLevel: "low" | "moderate" | "high";
};

const MIN_AGE = 18;

/**
 * UTILITIES
 */

function sanitizeNumber(
  raw: string,
  options: { min?: number; max?: number } = {}
): number | "" {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  let num = Number(trimmed);
  if (Number.isNaN(num)) return "";
  if (options.min !== undefined && num < options.min) num = options.min;
  if (options.max !== undefined && num > options.max) num = options.max;
  return num;
}

function clamp0to100(raw: string): number | "" {
  return sanitizeNumber(raw, { min: 0, max: 100 });
}

/**
 * RULE / HYBRID ENGINE (TS-SIDE, NOT THE PYTHON MODELS)
 */

function computeRiskScore(input: SingleInput): number {
  let riskScore = 0;

  // Severity
  if (input.severity === "mild") riskScore += 15;
  if (input.severity === "moderate") riskScore += 30;
  if (input.severity === "severe") riskScore += 45;

  // Age: we assume tool is for adults ≥ 18; extra risk if older
  if (typeof input.age === "number") {
    if (input.age >= 65) riskScore += 5;
    if (input.age >= 75) riskScore += 5;
  }

  // Symptom duration
  if (typeof input.symptomDurationMonths === "number") {
    if (input.symptomDurationMonths >= 12) riskScore += 5;
    if (input.symptomDurationMonths >= 24) riskScore += 5;
  }

  // Smoking – 3 levels
  if (input.smokingStatus === "former") {
    riskScore += 3;
  } else if (input.smokingStatus === "current") {
    riskScore += 6;
  }

  // MRI / structural risk
  if (input.t2Signal === "focal") riskScore += 5;
  if (input.t2Signal === "multilevel") riskScore += 10;
  if (input.canalRatio === ">60%") riskScore += 10;
  if (input.opp === 1) riskScore += 5;

  // Clinical markers
  if (input.gaitImpairment === 1) riskScore += 5;
  if (input.t1Hypo === 1) riskScore += 5;

  return Math.max(0, Math.min(100, riskScore));
}

function computeBenefitScore(input: SingleInput): number {
  let benefitScore = 0;

  // Baseline severity: moderate often has more "room to improve"
  if (input.severity === "mild") benefitScore += 40;
  if (input.severity === "moderate") benefitScore += 55;
  if (input.severity === "severe") benefitScore += 35;

  // Symptom duration – shorter is better
  if (typeof input.symptomDurationMonths === "number") {
    if (input.symptomDurationMonths < 6) benefitScore += 15;
    else if (input.symptomDurationMonths < 12) benefitScore += 10;
    else if (input.symptomDurationMonths < 24) benefitScore += 5;
    else benefitScore -= 5;
  }

  // Smoking – current smoker slightly lowers expected benefit
  if (input.smokingStatus === "current") benefitScore -= 5;
  if (input.smokingStatus === "former") benefitScore -= 2;

  // Planned levels – more levels → more risk, sometimes less gain
  if (typeof input.plannedLevels === "number") {
    if (input.plannedLevels > 3) benefitScore -= 5;
  }

  // Very low baseline mJOA (severe) can have lower probability of full MCID,
  // but still large absolute gain; we modestly trim:
  if (typeof input.baseline_mJOA === "number" && input.baseline_mJOA < 10) {
    benefitScore -= 5;
  }

  return Math.max(0, Math.min(100, benefitScore));
}

function computeSurgeryProbability(
  riskScore: number,
  benefitScore: number
): number {
  // Simple hybrid heuristic: if both risk and benefit are high, P(surgery) ~ high
  const base =
    0.2 * (riskScore / 100) + 0.8 * (benefitScore / 100); // benefit-weighted
  return Math.max(0, Math.min(1, base));
}

function classifyRecommendation(pSurgery: number): string {
  if (pSurgery < 0.3) {
    return "Non-operative trial reasonable with close follow-up";
  }
  if (pSurgery < 0.7) {
    return "Consider surgery versus continued conservative care";
  }
  return "Surgery recommended";
}

function computeApproachProbs(input: SingleInput): ApproachProbs {
  let anterior = 0.33;
  let posterior = 0.33;
  let circum = 0.34;

  const levels =
    typeof input.plannedLevels === "number" ? input.plannedLevels : 2;

  // Basic literature-style logic:
  // - ≤2 levels, ventral compression, no OPLL → anterior favored
  // - ≥3 levels, multilevel T2 / >60% compromise / OPLL → posterior or circumferential
  if (levels <= 2 && input.t2Signal === "focal" && input.opp === 0) {
    anterior += 0.2;
    posterior -= 0.1;
    circum -= 0.1;
  }

  if (levels >= 3 || input.t2Signal === "multilevel") {
    posterior += 0.15;
    anterior -= 0.05;
    circum += 0.05;
  }

  if (input.opp === 1 || input.canalRatio === ">60%") {
    circum += 0.1;
    posterior += 0.05;
    anterior -= 0.15;
  }

  // Normalize
  const sum = anterior + posterior + circum;
  return {
    anterior: Math.max(0, anterior / sum),
    posterior: Math.max(0, posterior / sum),
    circumferential: Math.max(0, circum / sum),
  };
}

function summarizeUncertainty(probs: ApproachProbs): "low" | "moderate" | "high" {
  const vals = Object.values(probs);
  const maxVal = Math.max(...vals);
  const minVal = Math.min(...vals);
  const spread = maxVal - minVal;
  if (spread >= 0.4) return "low";
  if (spread >= 0.2) return "moderate";
  return "high";
}

/**
 * DEFAULT INPUT
 */

const defaultInput: SingleInput = {
  age: "",
  sex: "M",
  smokingStatus: "never",
  symptomDurationMonths: "",
  severity: "moderate",
  baseline_mJOA: "",
  plannedLevels: "",
  opp: 0,
  canalRatio: "<50%",
  t2Signal: "none",
  t1Hypo: 0,
  gaitImpairment: 0,
  psychDisorder: 0,
  baseline_NDI: "",
  baseline_SF36_PCS: "",
  baseline_SF36_MCS: "",
};

/**
 * REACT PAGE
 */

export default function HomePage() {
  const [singleInput, setSingleInput] = useState<SingleInput>(defaultInput);
  const [singleResult, setSingleResult] = useState<SingleResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Very simple batch placeholder
  const [batchCsv, setBatchCsv] = useState<string>("");
  const [batchSummary, setBatchSummary] = useState<string | null>(null);

  function handleResetSingle() {
    setSingleInput(defaultInput);
    setSingleResult(null);
    setError(null);
  }

  function handleRunSingle() {
    setError(null);

    // Basic validation
    if (singleInput.age === "" || typeof singleInput.age !== "number") {
      setError("Please enter age (≥ 18 years).");
      return;
    }
    if (singleInput.age < MIN_AGE) {
      setError(`Tool is intended for adults. Please enter age ≥ ${MIN_AGE}.`);
      return;
    }

    if (
      singleInput.symptomDurationMonths === "" ||
      typeof singleInput.symptomDurationMonths !== "number"
    ) {
      setError("Please enter symptom duration (months).");
      return;
    }
    if (singleInput.symptomDurationMonths < 0) {
      setError("Symptom duration cannot be negative.");
      return;
    }

    if (
      singleInput.baseline_mJOA === "" ||
      typeof singleInput.baseline_mJOA !== "number"
    ) {
      setError("Please enter baseline mJOA.");
      return;
    }
    if (singleInput.baseline_mJOA < 0) {
      setError("Baseline mJOA cannot be negative.");
      return;
    }

    if (
      singleInput.plannedLevels === "" ||
      typeof singleInput.plannedLevels !== "number"
    ) {
      setError("Please enter planned operative levels.");
      return;
    }
    if (singleInput.plannedLevels < 0) {
      setError("Planned operative levels cannot be negative.");
      return;
    }

    const riskScore = computeRiskScore(singleInput);
    const benefitScore = computeBenefitScore(singleInput);
    const pSurgeryHybrid = computeSurgeryProbability(riskScore, benefitScore);
    const pMCID = Math.max(0, Math.min(1, benefitScore / 100));
    const recommendationLabel = classifyRecommendation(pSurgeryHybrid);

    const approachProbs = computeApproachProbs(singleInput);
    const entries = Object.entries(approachProbs) as [ApproachKey, number][];
    const sorted = [...entries].sort((a, b) => b[1] - a[1]);
    const bestApproach = sorted[0][0];
    const secondBestApproach = sorted[1][0];
    const uncertaintyLevel = summarizeUncertainty(approachProbs);

    // Keep "rule" probability just as a reference – here we reuse hybrid
    const pSurgeryRule = pSurgeryHybrid;

    const surgeryRecommended = pSurgeryHybrid >= 0.7;

    const riskText = (() => {
      if (riskScore < 20) {
        return "Low short-term neurologic progression risk based on current severity and imaging, but symptoms should be monitored and follow-up arranged.";
      }
      if (singleInput.severity === "mild") {
        return "Mild DCM with some long-term risk of neurologic progression, especially if symptoms persist or imaging changes evolve.";
      }
      if (singleInput.severity === "moderate") {
        return "Moderate DCM with meaningful risk of further neurologic deterioration without decompression.";
      }
      return "Severe DCM with high risk of further irreversible neurologic decline without decompression.";
    })();

    const benefitText =
      "Estimated probability of achieving clinically meaningful improvement in myelopathy based on severity, duration, MRI surrogates, and comorbidity patterns.";

    setSingleResult({
      normalizedInput: singleInput,
      pSurgeryRule,
      pSurgeryHybrid,
      pMCID,
      surgeryRecommended,
      recommendationLabel,
      riskScore,
      benefitScore,
      riskText,
      benefitText,
      approachProbs,
      bestApproach,
      secondBestApproach,
      uncertaintyLevel,
    });
  }

  function handleRunBatch() {
    if (!batchCsv.trim()) {
      setBatchSummary("No batch file content provided.");
      return;
    }
    // Placeholder summary only – real batch logic can call backend / parse CSV
    setBatchSummary(
      "Batch file uploaded. Final version will run all patients through the same engine and export a CSV/PDF with surgery probability, approach, and risk/benefit for each case."
    );
  }

  function renderApproachTag(key: ApproachKey): string {
    if (key === "anterior") return "ANTERIOR";
    if (key === "posterior") return "POSTERIOR";
    return "CIRCUMFERENTIAL / COMPLEX";
  }

  function renderApproachExplanation(result: SingleResult) {
    const { surgeryRecommended, bestApproach, secondBestApproach, uncertaintyLevel } =
      result;

    const bestLabel = renderApproachTag(bestApproach);
    const secondLabel = renderApproachTag(secondBestApproach);

    if (!surgeryRecommended) {
      // NEW: explicit wording when surgery is not recommended
      return (
        <p className="text-sm leading-relaxed text-slate-700">
          <span className="font-semibold">Non-operative management is favored at this stage.</span>{" "}
          If surgery is pursued later due to progression or shared decision-making, the model suggests{" "}
          <span className="font-semibold">{bestLabel}</span> as the{" "}
          <span className="italic">default operative strategy</span>, with{" "}
          <span className="font-semibold">{secondLabel}</span> as a secondary option. The{" "}
          <span className="font-semibold">{uncertaintyLevel} uncertainty</span> label highlights how
          strongly one approach is favored over others.
        </p>
      );
    }

    // When surgery is recommended
    return (
      <p className="text-sm leading-relaxed text-slate-700">
        The model favors a <span className="font-semibold">{bestLabel}</span> approach for this
        anatomy and planned construct, with <span className="font-semibold">{secondLabel}</span> as a
        reasonable alternative. The{" "}
        <span className="font-semibold">{uncertaintyLevel} uncertainty</span> label reflects how
        clearly one approach is favored over others; higher uncertainty suggests more value in
        multidisciplinary discussion and surgeon preference.
      </p>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      {/* HEADER */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 overflow-hidden rounded-xl bg-slate-900/90 p-1.5">
              {/* Logo sits on dark background so white edges blend */}
              <img
                src="/ascension-seton-logo.png"
                alt="Clinic logo"
                className="h-full w-full object-contain"
              />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                Degenerative Cervical Myelopathy Decision-Support Tool
              </h1>
              <p className="text-sm text-slate-500">
                Prototype: combines literature-informed rules with a hybrid scoring engine. Not a
                substitute for clinical judgment.
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* CONTENT */}
      <div className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        {/* SINGLE PATIENT */}
        <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">
                1) Should this patient undergo surgery?
              </h2>
              <p className="text-sm text-slate-500">
                Enter key clinical and imaging features. The tool estimates surgery vs non-operative
                management and expected benefit.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleResetSingle}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={handleRunSingle}
                className="rounded-full bg-slate-900 px-4 py-1.5 text-sm font-semibold text-white shadow hover:bg-slate-800"
              >
                Run recommendation
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="grid gap-6 md:grid-cols-2">
            {/* INPUT COLUMN */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Age (years)*
                  </label>
                  <input
                    type="number"
                    min={MIN_AGE}
                    max={95}
                    value={singleInput.age === "" ? "" : singleInput.age}
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        age: sanitizeNumber(e.target.value, {
                          min: MIN_AGE,
                          max: 95,
                        }),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  />
                  <p className="mt-1 text-xs text-slate-400">
                    Tool intended for adults ≥ {MIN_AGE} years.
                  </p>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Sex
                  </label>
                  <select
                    value={singleInput.sex}
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        sex: e.target.value === "F" ? "F" : "M",
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="M">Male</option>
                    <option value="F">Female</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Smoking status
                  </label>
                  <select
                    value={singleInput.smokingStatus}
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        smokingStatus: e.target.value as SmokingStatus,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="never">Never smoker</option>
                    <option value="former">Former smoker</option>
                    <option value="current">Current smoker</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Symptom duration (months)*
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={120}
                    value={
                      singleInput.symptomDurationMonths === ""
                        ? ""
                        : singleInput.symptomDurationMonths
                    }
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        symptomDurationMonths: sanitizeNumber(e.target.value, {
                          min: 0,
                          max: 120,
                        }),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Baseline mJOA (0–18)*
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={18}
                    value={
                      singleInput.baseline_mJOA === ""
                        ? ""
                        : singleInput.baseline_mJOA
                    }
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        baseline_mJOA: sanitizeNumber(e.target.value, {
                          min: 0,
                          max: 18,
                        }),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Severity (clinical)
                  </label>
                  <select
                    value={singleInput.severity}
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        severity: e.target.value as Severity,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="mild">Mild</option>
                    <option value="moderate">Moderate</option>
                    <option value="severe">Severe</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Planned operative levels*
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={8}
                    value={
                      singleInput.plannedLevels === ""
                        ? ""
                        : singleInput.plannedLevels
                    }
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        plannedLevels: sanitizeNumber(e.target.value, {
                          min: 0,
                          max: 8,
                        }),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    OPLL
                  </label>
                  <select
                    value={singleInput.opp}
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        opp: e.target.value === "1" ? 1 : 0,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="0">No</option>
                    <option value="1">Yes</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Canal occupying ratio
                  </label>
                  <select
                    value={singleInput.canalRatio}
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        canalRatio: e.target.value as CanalRatio,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="<50%">&lt; 50%</option>
                    <option value="50-60%">50–60%</option>
                    <option value=">60%">&gt; 60%</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    T2 cord signal
                  </label>
                  <select
                    value={singleInput.t2Signal}
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        t2Signal: e.target.value as T2Signal,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="none">None</option>
                    <option value="focal">Focal</option>
                    <option value="multilevel">Multilevel</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    T1 hypointensity
                  </label>
                  <select
                    value={singleInput.t1Hypo}
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        t1Hypo: e.target.value === "1" ? 1 : 0,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="0">No</option>
                    <option value="1">Yes</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Gait impairment
                  </label>
                  <select
                    value={singleInput.gaitImpairment}
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        gaitImpairment: e.target.value === "1" ? 1 : 0,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="0">No</option>
                    <option value="1">Yes</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Baseline NDI (0–100)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={
                      singleInput.baseline_NDI === ""
                        ? ""
                        : singleInput.baseline_NDI
                    }
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        baseline_NDI: clamp0to100(e.target.value),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    SF-36 PCS (0–100)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={
                      singleInput.baseline_SF36_PCS === ""
                        ? ""
                        : singleInput.baseline_SF36_PCS
                    }
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        baseline_SF36_PCS: clamp0to100(e.target.value),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    SF-36 MCS (0–100)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={
                      singleInput.baseline_SF36_MCS === ""
                        ? ""
                        : singleInput.baseline_SF36_MCS
                    }
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        baseline_SF36_MCS: clamp0to100(e.target.value),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Psychiatric comorbidity
                  </label>
                  <select
                    value={singleInput.psychDisorder}
                    onChange={(e) =>
                      setSingleInput((prev) => ({
                        ...prev,
                        psychDisorder: e.target.value === "1" ? 1 : 0,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="0">No</option>
                    <option value="1">Yes</option>
                  </select>
                </div>
              </div>
            </div>

            {/* OUTPUT COLUMN */}
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <h3 className="text-sm font-semibold text-slate-800">
                  Overall recommendation
                </h3>
                {singleResult ? (
                  <div className="mt-1 space-y-1.5">
                    <p className="text-base font-semibold">
                      {singleResult.recommendationLabel}
                    </p>
                    <p className="text-sm text-slate-600">
                      Estimated probability of recommending surgery (hybrid):
                      <span className="ml-1 font-semibold">
                        {(singleResult.pSurgeryHybrid * 100).toFixed(0)}%
                      </span>
                    </p>
                    <p className="text-sm text-slate-600">
                      Estimated probability of achieving a clinically meaningful
                      improvement in mJOA:
                      <span className="ml-1 font-semibold">
                        {(singleResult.pMCID * 100).toFixed(0)}%
                      </span>
                    </p>
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-slate-500">
                    Enter required fields and click{" "}
                    <span className="font-semibold">Run recommendation</span> to
                    see the prototype output.
                  </p>
                )}
              </div>

              {singleResult && (
                <>
                  <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                    <h3 className="text-sm font-semibold text-slate-800">
                      Risk vs Benefit (hybrid score)
                    </h3>
                    <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                          Neurologic progression risk
                        </p>
                        <p className="text-lg font-semibold">
                          {singleResult.riskScore} / 100
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {singleResult.riskText}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                          Expected benefit with surgery
                        </p>
                        <p className="text-lg font-semibold">
                          {singleResult.benefitScore} / 100
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {singleResult.benefitText}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                    <h3 className="text-sm font-semibold text-slate-800">
                      2) If surgery is offered, which approach?
                    </h3>
                    <div className="mt-2 flex gap-2">
                      {(
                        Object.entries(
                          singleResult.approachProbs
                        ) as [ApproachKey, number][]
                      ).map(([key, val]) => {
                        const isBest = singleResult.bestApproach === key;
                        const label = renderApproachTag(key);
                        return (
                          <div
                            key={key}
                            className={`flex-1 rounded-lg border px-3 py-2 ${
                              isBest
                                ? "border-slate-900 bg-slate-900 text-white"
                                : "border-slate-200 bg-slate-50 text-slate-800"
                            }`}
                          >
                            <p className="text-xs font-semibold uppercase tracking-wide">
                              {label}
                            </p>
                            <p className="mt-1 text-base font-semibold">
                              {(val * 100).toFixed(0)}%
                            </p>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-2">
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                        Interpretation
                      </p>
                      {renderApproachExplanation(singleResult)}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>

        {/* BATCH SECTION (placeholder) */}
        <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">
                3) Batch upload (work in progress)
              </h2>
              <p className="text-sm text-slate-500">
                Future version will accept CSV files and run all cases through
                the same engine, exporting an annotated CSV/PDF.
              </p>
            </div>
          </div>
          <div className="space-y-3">
            <textarea
              className="h-28 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-mono"
              placeholder="Paste CSV content here for prototype testing..."
              value={batchCsv}
              onChange={(e) => setBatchCsv(e.target.value)}
            />
            <button
              type="button"
              onClick={handleRunBatch}
              className="rounded-full bg-slate-900 px-4 py-1.5 text-sm font-semibold text-white shadow hover:bg-slate-800"
            >
              Run batch (prototype)
            </button>
            {batchSummary && (
              <p className="text-xs text-slate-600">{batchSummary}</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
