"use client";

import React, { useState, useMemo, ChangeEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { jsPDF } from "jspdf";
import {
  Upload,
  FileDown,
  Activity,
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  BarChart3,
} from "lucide-react";

// ---------------------------------------------
// TYPES
// ---------------------------------------------

type Sex = "M" | "F";
type Severity = "mild" | "moderate" | "severe";
type T2Signal = "none" | "focal" | "multilevel";
type CanalCat = "<50%" | "50-60%" | ">60%";

export type ApproachProbs = {
  anterior: number;
  posterior: number;
  circumferential: number;
};

// allow "none" when surgery is not recommended
export type BestApproach = keyof ApproachProbs | "none";

type UncertaintyLevel = "low" | "moderate" | "high";

interface PatientInput {
  age: number;
  sex: Sex;
  smoker: number;
  symptom_duration_months: number;
  severity: Severity; // derived from baseline_mJOA internally
  baseline_mJOA: number;
  levels_operated: number;
  OPLL: number;
  canal_occupying_ratio_cat: CanalCat;
  T2_signal: T2Signal;
  T1_hypointensity: number;
  gait_impairment: number;
  psych_disorder: number;
  baseline_NDI: number;
  baseline_SF36_PCS: number;
  baseline_SF36_MCS: number;
}

export interface SingleResult {
  normalizedInput: PatientInput;
  p_surgery_rule: number;
  p_surgery_ml: number;
  p_surgery_combined: number;
  surgery_recommended: boolean;
  recommendation_label: string;
  p_MCID_mJOA_ml: number;
  risk_score: number;
  benefit_score: number;
  risk_text: string;
  benefit_text: string;
  approach_probs_rule: ApproachProbs;
  approach_probs_ml: ApproachProbs;
  best_approach: BestApproach;
  best_approach_prob: number;
  second_best_approach_prob: number;
  uncertainty_level: UncertaintyLevel;
  rule_best_approach: keyof ApproachProbs;
  approach_probs: ApproachProbs;
}

// ---------------------------------------------
// SMALL UTILS
// ---------------------------------------------

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

function normalizeProbs(p: ApproachProbs): ApproachProbs {
  const sum = p.anterior + p.posterior + p.circumferential;
  if (sum <= 0) {
    return { anterior: 0, posterior: 0, circumferential: 0 };
  }
  return {
    anterior: p.anterior / sum,
    posterior: p.posterior / sum,
    circumferential: p.circumferential / sum,
  };
}

function deriveSeverityFromMJOA(baseline_mJOA: number): Severity {
  if (baseline_mJOA >= 15.5) return "mild";
  if (baseline_mJOA >= 12) return "moderate";
  return "severe";
}

function formatPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function formatPctBand(center: number, width = 0.1): string {
  const low = clamp01(center - width / 2);
  const high = clamp01(center + width / 2);
  return `${Math.round(low * 100)}–${Math.round(high * 100)}%`;
}

function computeUncertaintyLevel(probs: ApproachProbs): UncertaintyLevel {
  const vals = [probs.anterior, probs.posterior, probs.circumferential].sort(
    (a, b) => b - a
  );
  const top = vals[0];
  const second = vals[1];
  const diff = top - second;
  if (diff >= 0.25) return "low";
  if (diff >= 0.1) return "moderate";
  return "high";
}

// ---------------------------------------------
// HYBRID ENGINE (rules + simple ML-style logic)
// ---------------------------------------------

function computeRiskScore(input: PatientInput): number {
  const { baseline_mJOA, symptom_duration_months, T2_signal, T1_hypointensity, gait_impairment, OPLL } =
    input;
  const severity = deriveSeverityFromMJOA(baseline_mJOA);

  let base =
    severity === "mild" ? 20 : severity === "moderate" ? 55 : 80;

  if (symptom_duration_months > 24) base += 8;
  else if (symptom_duration_months > 12) base += 4;

  if (T2_signal === "focal") base += 6;
  if (T2_signal === "multilevel") base += 10;
  if (T1_hypointensity === 1) base += 6;
  if (gait_impairment === 1) base += 8;
  if (OPLL === 1) base += 6;

  return clamp(Math.round(base), 0, 100);
}

function computeBenefitScore(input: PatientInput): number {
  const {
    baseline_mJOA,
    symptom_duration_months,
    baseline_NDI,
    baseline_SF36_PCS,
  } = input;
  const severity = deriveSeverityFromMJOA(baseline_mJOA);

  let base =
    severity === "mild" ? 80 : severity === "moderate" ? 40 : 10;

  if (symptom_duration_months > 24) base -= 10;
  else if (symptom_duration_months > 12) base -= 5;

  if (baseline_mJOA < 12) base -= 8;
  if (baseline_NDI >= 40) base += 5;
  if (baseline_SF36_PCS <= 35) base += 5;

  return clamp(Math.round(base), 0, 100);
}

function computeSurgeryProbRule(input: PatientInput): number {
  const severity = deriveSeverityFromMJOA(input.baseline_mJOA);
  const { symptom_duration_months, T2_signal, gait_impairment } = input;

  if (severity === "mild") {
    const highRisk =
      symptom_duration_months > 12 ||
      T2_signal !== "none" ||
      gait_impairment === 1;
    return highRisk ? 0.8 : 0.2;
  }
  if (severity === "moderate") {
    return 0.8;
  }
  return 0.9;
}

function computeSurgeryProbML(
  riskScore: number,
  benefitScore: number
): number {
  const base = 0.2 + 0.4 * (riskScore / 100) + 0.2 * (benefitScore / 100);
  return clamp01(base);
}

function buildApproachProbsRule(input: PatientInput): ApproachProbs {
  const {
    levels_operated,
    OPLL,
    canal_occupying_ratio_cat,
    T2_signal,
    baseline_mJOA,
  } = input;
  let p: ApproachProbs = {
    anterior: 0.4,
    posterior: 0.4,
    circumferential: 0.2,
  };

  if (
    levels_operated <= 2 &&
    OPLL === 0 &&
    canal_occupying_ratio_cat !== ">60%" &&
    T2_signal !== "multilevel"
  ) {
    p.anterior += 0.2;
    p.posterior -= 0.1;
    p.circumferential -= 0.1;
  }

  if (levels_operated >= 4 || T2_signal === "multilevel") {
    p.posterior += 0.2;
    p.anterior -= 0.1;
    p.circumferential += 0.1;
  }

  if (OPLL === 1 && canal_occupying_ratio_cat === ">60%") {
    p.circumferential += 0.3;
    p.posterior += 0.1;
    p.anterior -= 0.4;
  }

  if (baseline_mJOA < 12 && levels_operated >= 4) {
    p.circumferential += 0.1;
    p.posterior += 0.05;
    p.anterior -= 0.15;
  }

  p.anterior = Math.max(0, p.anterior);
  p.posterior = Math.max(0, p.posterior);
  p.circumferential = Math.max(0, p.circumferential);

  return normalizeProbs(p);
}

function buildApproachProbsML(rule: ApproachProbs): ApproachProbs {
  const ml: ApproachProbs = {
    anterior: 0.5 * rule.anterior + 0.15,
    posterior: 0.5 * rule.posterior + 0.15,
    circumferential: 0.5 * rule.circumferential + 0.1,
  };
  return normalizeProbs(ml);
}

function pickBestApproach(probs: ApproachProbs): BestApproach {
  const entries: [keyof ApproachProbs, number][] = [
    ["anterior", probs.anterior],
    ["posterior", probs.posterior],
    ["circumferential", probs.circumferential],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  const [bestKey, bestVal] = entries[0];
  if (bestVal <= 0) return "none";
  return bestKey;
}

function getApproachTexts(
  severity: Severity,
  best: BestApproach
): string {
  if (best === "none") {
    return "No surgical approach is suggested because a structured non-operative trial is reasonable at this time.";
  }
  if (best === "anterior") {
    return "Anterior decompression is favored for focal ventral compression, 1–2 level disease, and kyphotic segments consistent with AO Spine / WFNS concepts.";
  }
  if (best === "posterior") {
    return "Posterior decompression is favored for multilevel dorsal compression, preserved lordosis, and extensive dorsal spondylosis.";
  }
  return "Combined circumferential strategies are reserved for rigid deformity, high canal compromise, or OPLL scenarios where single-approach decompression may be inadequate.";
}

function buildRiskText(
  severity: Severity,
  riskScore: number
): string {
  if (riskScore < 20) {
    return "Low short-term neurologic progression risk based on current severity and imaging, but symptoms should be monitored and follow-up arranged.";
  }
  if (severity === "mild") {
    return "Mild DCM with some long-term risk of neurologic progression, especially if symptoms persist or imaging changes evolve.";
  }
  if (severity === "moderate") {
    return "Moderate DCM with meaningful risk of neurologic deterioration if decompression is delayed, consistent with guideline recommendations for surgery.";
  }
  return "Severe DCM with high risk of further irreversible neurologic decline without decompression, aligning with recommendations for timely surgery.";
}

function buildBenefitText(): string {
  return "Estimated probability of achieving clinically meaningful improvement in mJOA based on severity, symptom duration, MRI surrogates, and comorbidity patterns.";
}

function runHybridEngine(raw: Partial<PatientInput>): SingleResult {
  const normalized: PatientInput = {
    age: Number(raw.age ?? 60),
    sex: (raw.sex as Sex) || "M",
    smoker: Number(raw.smoker ?? 0),
    symptom_duration_months: Number(raw.symptom_duration_months ?? 12),
    severity:
      (raw.severity as Severity) ||
      deriveSeverityFromMJOA(Number(raw.baseline_mJOA ?? 13)),
    baseline_mJOA: Number(raw.baseline_mJOA ?? 13),
    levels_operated: Number(raw.levels_operated ?? 3),
    OPLL: Number(raw.OPLL ?? 0),
    canal_occupying_ratio_cat:
      (raw.canal_occupying_ratio_cat as CanalCat) || "<50%",
    T2_signal: (raw.T2_signal as T2Signal) || "none",
    T1_hypointensity: Number(raw.T1_hypointensity ?? 0),
    gait_impairment: Number(raw.gait_impairment ?? 0),
    psych_disorder: Number(raw.psych_disorder ?? 0),
    baseline_NDI: Number(raw.baseline_NDI ?? 30),
    baseline_SF36_PCS: Number(raw.baseline_SF36_PCS ?? 40),
    baseline_SF36_MCS: Number(raw.baseline_SF36_MCS ?? 45),
  };

  normalized.severity = deriveSeverityFromMJOA(normalized.baseline_mJOA);
  const severity = normalized.severity;

  const risk_score = computeRiskScore(normalized);
  const benefit_score = computeBenefitScore(normalized);

  const p_surgery_rule = computeSurgeryProbRule(normalized);
  const p_surgery_ml = computeSurgeryProbML(risk_score, benefit_score);
  const p_surgery_combined = clamp01(
    (p_surgery_rule + p_surgery_ml) / 2
  );

  let surgery_recommended = false;
  let recommendation_label: string;

  if (p_surgery_combined < 0.35 && severity === "mild") {
    surgery_recommended = false;
    recommendation_label =
      "Non-operative trial reasonable with close follow-up";
  } else if (p_surgery_combined < 0.7) {
    surgery_recommended = true;
    recommendation_label = "Consider surgery / surgery likely beneficial";
  } else {
    surgery_recommended = true;
    recommendation_label = "Surgery recommended";
  }

  // Simple "ML" MCID probability anchored on benefit score
  const p_MCID_mJOA_ml = clamp01(benefit_score / 100);

  let approach_probs_rule: ApproachProbs = {
    anterior: 0,
    posterior: 0,
    circumferential: 0,
  };
  let approach_probs_ml: ApproachProbs = {
    anterior: 0,
    posterior: 0,
    circumferential: 0,
  };

  if (surgery_recommended) {
    approach_probs_rule = buildApproachProbsRule(normalized);
    approach_probs_ml = buildApproachProbsML(approach_probs_rule);
  }

  const approach_probs: ApproachProbs = surgery_recommended
    ? normalizeProbs({
        anterior:
          (approach_probs_rule.anterior + approach_probs_ml.anterior) /
          2,
        posterior:
          (approach_probs_rule.posterior +
            approach_probs_ml.posterior) /
          2,
        circumferential:
          (approach_probs_rule.circumferential +
            approach_probs_ml.circumferential) /
          2,
      })
    : { anterior: 0, posterior: 0, circumferential: 0 };

  const rule_best_approach = surgery_recommended
    ? pickBestApproach(approach_probs_rule)
    : "none";

  const best_approach = surgery_recommended
    ? pickBestApproach(approach_probs)
    : "none";

  const vals: [keyof ApproachProbs, number][] = [
    ["anterior", approach_probs.anterior],
    ["posterior", approach_probs.posterior],
    ["circumferential", approach_probs.circumferential],
  ].sort((a, b) => b[1] - a[1]);

  const best_approach_prob =
    best_approach === "none"
      ? 0
      : vals.find(([k]) => k === best_approach)?.[1] ?? 0;
  const second_best_approach_prob = vals[1]?.[1] ?? 0;

  const uncertainty_level: UncertaintyLevel = surgery_recommended
    ? computeUncertaintyLevel(approach_probs)
    : "moderate";

  const risk_text = buildRiskText(severity, risk_score);
  const benefit_text = buildBenefitText();

  return {
    normalizedInput: normalized,
    p_surgery_rule,
    p_surgery_ml,
    p_surgery_combined,
    surgery_recommended,
    recommendation_label,
    p_MCID_mJOA_ml,
    risk_score,
    benefit_score,
    risk_text,
    benefit_text,
    approach_probs_rule,
    approach_probs_ml,
    best_approach,
    best_approach_prob,
    second_best_approach_prob,
    uncertainty_level,
    rule_best_approach:
      rule_best_approach === "none"
        ? "posterior"
        : (rule_best_approach as keyof ApproachProbs),
    approach_probs,
  };
}

// ---------------------------------------------
// PDF SUMMARY
// ---------------------------------------------

function downloadPdfSummary(result: SingleResult) {
  const doc = new jsPDF();
  const margin = 14;
  let y = 18;

  doc.setFontSize(16);
  doc.text("DCM Surgery Recommender – Summary", margin, y);
  y += 10;

  doc.setFontSize(12);
  doc.text("Ascension Texas Spine and Scoliosis", margin, y);
  y += 8;

  y += 4;
  doc.setFontSize(11);
  doc.text("Patient inputs", margin, y);
  y += 6;

  const p = result.normalizedInput;
  const linesInputs = [
    `Age ${p.age}, Sex ${p.sex}, Smoker ${p.smoker ? "Yes" : "No"}`,
    `Symptom duration: ${p.symptom_duration_months} months`,
    `mJOA: ${p.baseline_mJOA.toFixed(1)} (derived severity: ${
      p.severity
    })`,
    `Levels planned: ${p.levels_operated}, OPLL: ${
      p.OPLL ? "Yes" : "No"
    }`,
    `Canal compromise: ${p.canal_occupying_ratio_cat}`,
    `T2 signal: ${p.T2_signal}, T1 hypointensity: ${
      p.T1_hypointensity ? "Yes" : "No"
    }`,
    `Gait impairment: ${p.gait_impairment ? "Yes" : "No"}`,
    `Baseline NDI: ${p.baseline_NDI.toFixed(
      1
    )}, SF-36 PCS: ${p.baseline_SF36_PCS.toFixed(
      1
    )}, MCS: ${p.baseline_SF36_MCS.toFixed(1)}`,
  ];

  linesInputs.forEach((line) => {
    doc.text(line, margin, y);
    y += 6;
  });

  y += 4;
  doc.text("1) Should this patient undergo surgery?", margin, y);
  y += 6;

  doc.text(
    `Combined surgery probability: ${formatPct(
      result.p_surgery_combined
    )}`,
    margin,
    y
  );
  y += 6;
  doc.text(`Recommendation: ${result.recommendation_label}`, margin, y);
  y += 6;
  doc.text(`Risk score: ${result.risk_score}/100`, margin, y);
  y += 6;
  doc.text(`Benefit score: ${result.benefit_score}/100`, margin, y);
  y += 6;

  y += 4;
  doc.text("2) If surgery is offered, which approach?", margin, y);
  y += 6;

  if (!result.surgery_recommended) {
    doc.text(
      "No approach recommended – structured non-operative trial suggested.",
      margin,
      y
    );
    doc.save("dcm_surgery_recommender_summary.pdf");
    return;
  }

  const ap = result.approach_probs;
  doc.text(
    `Approach probabilities (hybrid): ANT ${formatPct(
      ap.anterior
    )}, POST ${formatPct(ap.posterior)}, CIRC ${formatPct(
      ap.circumferential
    )}`,
    margin,
    y
  );
  y += 6;
  doc.text(
    `Best approach: ${result.best_approach.toUpperCase()} (uncertainty: ${
      result.uncertainty_level
    })`,
    margin,
    y
  );
  y += 8;

  const desc = getApproachTexts(
    result.normalizedInput.severity,
    result.best_approach
  );
  const wrapped = doc.splitTextToSize(desc, 180);
  doc.text(wrapped, margin, y);

  doc.save("dcm_surgery_recommender_summary.pdf");
}

// ---------------------------------------------
// CSV PARSE FOR BATCH
// ---------------------------------------------

function parseCsv(text: string): Partial<PatientInput>[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const rows: Partial<PatientInput>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const row: any = {};
    header.forEach((h, idx) => {
      row[h] = cols[idx];
    });
    rows.push(row);
  }

  return rows;
}

// ---------------------------------------------
// COMPONENT
// ---------------------------------------------

export default function PrototypePage() {
  const [tab, setTab] = useState<"single" | "batch">("single");

  const [input, setInput] = useState<Partial<PatientInput>>({
    age: 65,
    sex: "M",
    smoker: 0,
    symptom_duration_months: 12,
    baseline_mJOA: 12,
    severity: "moderate",
    levels_operated: 3,
    OPLL: 0,
    canal_occupying_ratio_cat: "50-60%",
    T2_signal: "multilevel",
    T1_hypointensity: 0,
    gait_impairment: 1,
    psych_disorder: 0,
    baseline_NDI: 40,
    baseline_SF36_PCS: 40,
    baseline_SF36_MCS: 45,
  });

  const [singleResult, setSingleResult] = useState<SingleResult | null>(
    null
  );
  const [batchResults, setBatchResults] = useState<SingleResult[]>([]);
  const [batchFileName, setBatchFileName] = useState<string | null>(null);

  const derivedSeverity = useMemo(
    () => deriveSeverityFromMJOA(Number(input.baseline_mJOA ?? 13)),
    [input.baseline_mJOA]
  );

  const handleInputChange =
    (field: keyof PatientInput) =>
    (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value =
        e.target.type === "number"
          ? Number(e.target.value)
          : e.target.value;
      setInput((prev) => ({
        ...prev,
        [field]: value,
      }));
    };

  const handleRunSingle = () => {
    const res = runHybridEngine(input);
    setSingleResult(res);
  };

  const handleBatchFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBatchFileName(file.name);
    const text = await file.text();
    const rows = parseCsv(text);
    const results = rows.map((r) => runHybridEngine(r));
    setBatchResults(results);
    setTab("batch");
  };

  return (
    <main className="min-h-screen bg-slate-50 pb-20">
      {/* Top navigation / back */}
      <div className="px-6 md:px-10 pt-6 md:pt-8 max-w-6xl mx-auto">
        <div className="flex items-center justify-between gap-3 mb-4">
          <Link
            href="/"
            className="inline-flex items-center text-sm text-slate-600 hover:text-slate-900"
          >
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back to overview
          </Link>
          <span className="inline-flex items-center gap-2 text-xs md:text-sm text-slate-500">
            <Activity className="h-4 w-4" />
            Degenerative Cervical Myelopathy Decision Support
          </span>
        </div>
      </div>

      <div className="px-6 md:px-10 max-w-6xl mx-auto space-y-8">
        {/* HEADER: LOGO + TITLE */}
        <header className="flex flex-col items-center text-center gap-4">
          <div className="relative flex flex-col items-center justify-center">
            <div className="relative h-24 w-72 rounded-3xl bg-[#f5f7fb] shadow-sm flex items-center justify-center">
              {/* The surrounding background is matched to the logo so white border blends */}
              <Image
                src="/ascension-seton-logo.png"
                alt="Ascension Texas Spine and Scoliosis"
                fill
                style={{ objectFit: "contain", padding: "12px" }}
                priority
              />
            </div>
          </div>
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold text-slate-900">
              Ascension Texas Spine and Scoliosis
            </h1>
            <p className="mt-2 text-sm md:text-base text-slate-600 max-w-2xl mx-auto">
              Hybrid literature- and data-informed prototype to support
              discussions about when to offer surgery for degenerative
              cervical myelopathy and which approach may provide the
              highest chance of meaningful improvement.
            </p>
          </div>
        </header>

        {/* TABS: SINGLE vs BATCH */}
        <div className="flex items-center justify-center mt-4">
          <div className="inline-flex rounded-full bg-white shadow-sm border border-slate-200 overflow-hidden">
            <button
              type="button"
              onClick={() => setTab("single")}
              className={`px-4 py-2 text-sm md:text-base font-medium transition ${
                tab === "single"
                  ? "bg-sky-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              Single patient
            </button>
            <button
              type="button"
              onClick={() => setTab("batch")}
              className={`px-4 py-2 text-sm md:text-base font-medium border-l border-slate-200 transition ${
                tab === "batch"
                  ? "bg-sky-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              Batch CSV
            </button>
          </div>
        </div>

        {/* MAIN GRID */}
        <div className="grid md:grid-cols-2 gap-6 md:gap-8 items-start">
          {/* LEFT: INPUTS */}
          <section className="space-y-5">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 md:p-5">
              <h2 className="text-lg md:text-xl font-semibold text-slate-900 mb-2 flex items-center gap-2">
                Patient inputs
                <span className="text-xs font-normal text-slate-500">
                  (baseline clinical + MRI surrogates)
                </span>
              </h2>

              <div className="grid grid-cols-2 gap-3 text-xs md:text-sm">
                {/* Row 1: Age / Sex */}
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    Age (years)
                  </label>
                  <input
                    type="number"
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-sky-500 text-sm"
                    value={input.age ?? ""}
                    onChange={handleInputChange("age")}
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-600">Sex</label>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.sex ?? "M"}
                    onChange={handleInputChange("sex")}
                  >
                    <option value="M">Male</option>
                    <option value="F">Female</option>
                  </select>
                </div>

                {/* Row 2: Smoker / Duration */}
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    Smoker (0/1)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.smoker ?? 0}
                    onChange={handleInputChange("smoker")}
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    Symptom duration (months)
                  </label>
                  <input
                    type="number"
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.symptom_duration_months ?? ""}
                    onChange={handleInputChange("symptom_duration_months")}
                  />
                </div>

                {/* Row 3: mJOA / derived severity */}
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    Baseline mJOA
                  </label>
                  <input
                    type="number"
                    step={0.1}
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.baseline_mJOA ?? ""}
                    onChange={handleInputChange("baseline_mJOA")}
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    Derived severity (from mJOA)
                  </label>
                  <div className="w-full rounded-lg border border-dashed border-slate-200 px-2 py-1.5 text-sm bg-slate-50 text-slate-700">
                    {derivedSeverity.toUpperCase()}
                  </div>
                </div>

                {/* Row 4: Levels / OPLL */}
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    Levels planned
                  </label>
                  <input
                    type="number"
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.levels_operated ?? ""}
                    onChange={handleInputChange("levels_operated")}
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    OPLL (0/1)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.OPLL ?? 0}
                    onChange={handleInputChange("OPLL")}
                  />
                </div>

                {/* Row 5: Canal ratio / T2 */}
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    Canal occupying ratio
                  </label>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.canal_occupying_ratio_cat ?? "<50%"}
                    onChange={handleInputChange("canal_occupying_ratio_cat")}
                  >
                    <option value="<50%">&lt;50%</option>
                    <option value="50-60%">50–60%</option>
                    <option value=">60%">&gt;60%</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    T2 cord signal
                  </label>
                  <select
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.T2_signal ?? "none"}
                    onChange={handleInputChange("T2_signal")}
                  >
                    <option value="none">None</option>
                    <option value="focal">Focal</option>
                    <option value="multilevel">Multilevel</option>
                  </select>
                </div>

                {/* Row 6: T1 / gait */}
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    T1 hypointensity (0/1)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.T1_hypointensity ?? 0}
                    onChange={handleInputChange("T1_hypointensity")}
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    Gait impairment (0/1)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.gait_impairment ?? 0}
                    onChange={handleInputChange("gait_impairment")}
                  />
                </div>

                {/* Row 7: Psych / NDI */}
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    Psych disorder (0/1)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.psych_disorder ?? 0}
                    onChange={handleInputChange("psych_disorder")}
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    Baseline NDI
                  </label>
                  <input
                    type="number"
                    step={0.1}
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.baseline_NDI ?? ""}
                    onChange={handleInputChange("baseline_NDI")}
                  />
                </div>

                {/* Row 8: SF36 PCS / MCS */}
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    SF-36 PCS
                  </label>
                  <input
                    type="number"
                    step={0.1}
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.baseline_SF36_PCS ?? ""}
                    onChange={handleInputChange("baseline_SF36_PCS")}
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-slate-600">
                    SF-36 MCS
                  </label>
                  <input
                    type="number"
                    step={0.1}
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-sky-500"
                    value={input.baseline_SF36_MCS ?? ""}
                    onChange={handleInputChange("baseline_SF36_MCS")}
                  />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={handleRunSingle}
                  className="inline-flex items-center gap-2 rounded-full bg-sky-600 text-white px-4 py-2 text-sm md:text-base font-semibold shadow-sm hover:bg-sky-700 transition"
                >
                  <BarChart3 className="h-4 w-4" />
                  Run recommendation
                </button>

                <label className="inline-flex items-center gap-2 text-xs md:text-sm text-slate-600 cursor-pointer">
                  <Upload className="h-4 w-4" />
                  <span>Batch CSV (optional)</span>
                  <input
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={handleBatchFile}
                  />
                </label>
              </div>

              {batchFileName && (
                <p className="mt-2 text-xs text-slate-500">
                  Loaded batch file: <span className="font-medium">{batchFileName}</span>
                </p>
              )}
            </div>

            {/* Small note */}
            <div className="text-xs text-slate-500 bg-sky-50 border border-sky-100 rounded-xl p-3">
              This interface mirrors the variables that will be available in
              the clinical dataset. The underlying engine blends published
              DCM guideline concepts (AO Spine / WFNS, etc.) with patterns
              learned from synthetic outcomes to encourage discussion rather
              than replace judgement.
            </div>
          </section>

          {/* RIGHT: RESULTS */}
          <section className="space-y-5">
            {/* CARD 1 – Should this patient undergo surgery? */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 md:p-5 space-y-4">
              <h2 className="text-lg md:text-xl font-semibold flex items-center gap-2">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-sky-600 text-white text-sm">
                  1
                </span>
                <span className="text-slate-900">
                  Should this patient undergo surgery?
                </span>
              </h2>

              {singleResult ? (
                <>
                  <div
                    className={`rounded-xl p-3 md:p-4 border text-sm md:text-base ${
                      singleResult.surgery_recommended
                        ? "border-emerald-200 bg-emerald-50/80 text-emerald-900"
                        : "border-amber-200 bg-amber-50/80 text-amber-900"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {singleResult.surgery_recommended ? (
                        <CheckCircle2 className="h-5 w-5 mt-0.5" />
                      ) : (
                        <AlertTriangle className="h-5 w-5 mt-0.5" />
                      )}
                      <div>
                        <p className="font-semibold">
                          {singleResult.recommendation_label}
                        </p>
                        <p className="mt-1 text-xs md:text-sm opacity-90">
                          Combined surgery probability:{" "}
                          <span className="font-semibold">
                            {formatPct(singleResult.p_surgery_combined)}
                          </span>
                          . This blends guideline-style risk rules with a
                          simple ML estimate calibrated on synthetic DCM
                          outcomes.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Risk vs benefit dial */}
                  <div className="space-y-3 text-xs md:text-sm">
                    <p className="font-semibold text-slate-800">
                      Risk vs expected benefit
                    </p>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px] text-slate-500">
                        <span>Risk without surgery</span>
                        <span>{singleResult.risk_score}/100</span>
                      </div>
                      <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-rose-400"
                          style={{
                            width: `${singleResult.risk_score}%`,
                          }}
                        ></div>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between text-[11px] text-slate-500">
                        <span>Expected benefit with surgery</span>
                        <span>{singleResult.benefit_score}/100</span>
                      </div>
                      <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-emerald-400"
                          style={{
                            width: `${singleResult.benefit_score}%`,
                          }}
                        ></div>
                      </div>
                    </div>

                    <p className="text-[11px] text-slate-500 mt-1">
                      <span className="font-semibold">Risk score</span>{" "}
                      reflects progression risk without decompression.{" "}
                      <span className="font-semibold">Benefit score</span>{" "}
                      approximates the probability of achieving clinically
                      meaningful improvement in mJOA.
                    </p>

                    <p className="text-[11px] text-slate-500 mt-1">
                      {singleResult.risk_text}
                    </p>
                  </div>
                </>
              ) : (
                <p className="text-sm text-slate-500">
                  Enter baseline values on the left and click{" "}
                  <span className="font-semibold">Run recommendation</span>{" "}
                  to see the surgery recommendation and risk–benefit dial.
                </p>
              )}
            </div>

            {/* CARD 2 – If surgery is offered, which approach? */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 md:p-5 space-y-4">
              <h2 className="text-lg md:text-xl font-semibold flex items-center gap-2">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-white text-sm">
                  2
                </span>
                <span className="text-slate-900">
                  If surgery is offered, which approach?
                </span>
              </h2>

              {singleResult && singleResult.surgery_recommended ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs md:text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-600">Best approach:</span>
                      <span className="inline-flex items-center rounded-full bg-indigo-50 border border-indigo-200 px-3 py-1 text-xs font-semibold text-indigo-700">
                        {singleResult.best_approach.toUpperCase()}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] md:text-xs text-slate-500">
                      <span className="font-semibold">Uncertainty:</span>
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 border border-slate-200 bg-slate-50 capitalize">
                        {singleResult.uncertainty_level}
                      </span>
                      <span className="hidden md:inline">
                        (how close the approach probabilities are —{" "}
                        <strong>low</strong> = one approach clearly
                        dominates; <strong>high</strong> = approaches are
                        similar and shared decision-making is key)
                      </span>
                    </div>
                  </div>

                  {/* Approach cards with confidence bands */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 text-xs md:text-sm">
                    {(
                      ["anterior", "posterior", "circumferential"] as const
                    ).map((key) => {
                      const val = singleResult.approach_probs[key];
                      const band = formatPctBand(val, 0.15);
                      const isBest =
                        singleResult.best_approach === key &&
                        singleResult.best_approach !== "none";
                      const label =
                        key === "anterior"
                          ? "ANTERIOR"
                          : key === "posterior"
                          ? "POSTERIOR"
                          : "CIRCUMFERENTIAL";
                      return (
                        <div
                          key={key}
                          className={`rounded-xl border p-3 md:p-3.5 flex flex-col gap-1 ${
                            isBest
                              ? "border-indigo-300 bg-indigo-50/80"
                              : "border-slate-200 bg-slate-50/80"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <p className="font-semibold text-slate-800">
                              {label}
                            </p>
                            {isBest && (
                              <span className="text-[10px] uppercase tracking-wide text-indigo-700 font-semibold">
                                Favored
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-600">
                            Hybrid probability:{" "}
                            <span className="font-semibold">
                              {formatPct(val)}
                            </span>
                          </p>
                          <p className="text-[11px] text-slate-500">
                            Approximate confidence band:{" "}
                            <span className="font-semibold">{band}</span>
                          </p>
                          <div className="mt-1 h-2 rounded-full bg-slate-200 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                key === "anterior"
                                  ? "bg-sky-400"
                                  : key === "posterior"
                                  ? "bg-emerald-400"
                                  : "bg-amber-400"
                              }`}
                              style={{ width: `${val * 100}%` }}
                            ></div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Text explanation */}
                  <p className="mt-3 text-[11px] md:text-xs text-slate-600">
                    These approach probabilities reflect both guideline-like
                    rules (e.g., levels, OPLL, canal compromise, T2 signal)
                    and simple ML patterns learned from synthetic outcomes.
                    “Uncertainty” summarizes how distinct those probabilities
                    are: low when one approach clearly dominates, higher when
                    approaches are similar and surgeon preference / patient
                    values play a larger role.
                  </p>

                  {/* Approach explanation text */}
                  <p className="mt-2 text-[11px] md:text-xs text-slate-600">
                    {getApproachTexts(
                      singleResult.normalizedInput.severity,
                      singleResult.best_approach
                    )}
                  </p>

                  {/* PDF button */}
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => singleResult && downloadPdfSummary(singleResult)}
                      className="inline-flex items-center gap-2 rounded-full bg-slate-900 text-white px-4 py-2 text-xs md:text-sm font-semibold shadow-sm hover:bg-slate-800 transition"
                    >
                      <FileDown className="h-4 w-4" />
                      Download PDF summary
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-slate-500">
                  Once surgery is recommended, this section will summarize
                  probabilities for anterior, posterior, and circumferential
                  strategies, show an uncertainty tag, and allow you to
                  export a one-page PDF for discussion or conference.
                </p>
              )}
            </div>

            {/* CARD 3 – Batch results */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 md:p-5 space-y-3">
              <h2 className="text-sm md:text-base font-semibold text-slate-900 flex items-center gap-2">
                <Upload className="h-4 w-4" />
                Batch upload: multiple patients (CSV)
              </h2>
              <p className="text-xs md:text-sm text-slate-500">
                Upload a CSV with columns matching the input panel
                (e.g., <code className="font-mono text-[11px]">
                  age, sex, smoker, symptom_duration_months,
                  baseline_mJOA, levels_operated, OPLL,
                  canal_occupying_ratio_cat, T2_signal,
                  T1_hypointensity, gait_impairment, psych_disorder,
                  baseline_NDI, baseline_SF36_PCS, baseline_SF36_MCS
                </code>
                ). The same hybrid engine is applied to each row.
              </p>

              {batchResults.length > 0 ? (
                <div className="max-h-64 overflow-auto border border-slate-100 rounded-xl mt-2">
                  <table className="min-w-full text-[11px] md:text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-2 py-1 text-left font-semibold">
                          #
                        </th>
                        <th className="px-2 py-1 text-left font-semibold">
                          mJOA / severity
                        </th>
                        <th className="px-2 py-1 text-left font-semibold">
                          Surgery?
                        </th>
                        <th className="px-2 py-1 text-left font-semibold">
                          P(surgery)
                        </th>
                        <th className="px-2 py-1 text-left font-semibold">
                          Approach
                        </th>
                        <th className="px-2 py-1 text-left font-semibold">
                          Uncertainty
                        </th>
                        <th className="px-2 py-1 text-left font-semibold">
                          Risk / Benefit
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchResults.map((r, idx) => (
                        <tr
                          key={idx}
                          className={
                            idx % 2 === 0 ? "bg-white" : "bg-slate-50/60"
                          }
                        >
                          <td className="px-2 py-1">{idx + 1}</td>
                          <td className="px-2 py-1">
                            {r.normalizedInput.baseline_mJOA.toFixed(1)} /{" "}
                            {r.normalizedInput.severity}
                          </td>
                          <td className="px-2 py-1">
                            {r.surgery_recommended ? "Yes" : "No"}
                          </td>
                          <td className="px-2 py-1">
                            {formatPct(r.p_surgery_combined)}
                          </td>
                          <td className="px-2 py-1">
                            {r.best_approach === "none"
                              ? "-"
                              : r.best_approach.toUpperCase()}
                          </td>
                          <td className="px-2 py-1 capitalize">
                            {r.uncertainty_level}
                          </td>
                          <td className="px-2 py-1">
                            {r.risk_score}/{r.benefit_score}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  No batch file processed yet. Use the CSV upload control
                  above to validate the engine across multiple synthetic or
                  real-world patients.
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
