"use client";

import React, { useMemo, useState } from "react";
import { ArrowLeft, BarChart3, FileDown, Info, Loader2 } from "lucide-react";
import Link from "next/link";
import jsPDF from "jspdf";

// ----------------------
// Types
// ----------------------

type Severity = "mild" | "moderate" | "severe";
type ApproachKey = "anterior" | "posterior" | "circumferential";

interface ApproachProbs {
  anterior: number;
  posterior: number;
  circumferential: number;
}

type UncertaintyLevel = "low" | "moderate" | "high";

interface SingleInputs {
  age: string;
  sex: string;
  smoker: string;
  symptomDurationMonths: string;
  mJOA: string;
  severity: string;
  t2Signal: string;
  levelsOperated: string;
  canalOccupyingRatio: string;
  opll: string;
  t1Hypo: string;
  gaitImpairment: string;
  psychDisorder: string;
  baselineNDI: string;
  sf36PCS: string;
  sf36MCS: string;
}

interface SingleResult {
  normalizedInput: {
    age: number;
    sex: string;
    smoker: number;
    symptomDurationMonths: number;
    severity: Severity;
    baseline_mJOA: number;
    levels_operated: number;
    OPLL: number;
    canal_occupying_ratio_cat: string;
    T2_signal: string;
    T1_hypointensity: number;
    gait_impairment: number;
    psych_disorder: number;
    baseline_NDI: number;
    baseline_SF36_PCS: number;
    baseline_SF36_MCS: number;
  };
  pSurgeryCombined: number;
  pSurgeryRule: number;
  pSurgeryML: number;
  pMCID_mJOA: number;
  surgeryRecommended: boolean;
  recommendationLabel: string;
  riskScore: number; // 0–100
  benefitScore: number; // 0–100
  riskText: string;
  benefitText: string;
  approachProbs: ApproachProbs;
  bestApproach: ApproachKey;
  uncertaintyLevel: UncertaintyLevel;
}

interface BatchRowResult extends SingleResult {
  rowIndex: number;
}

// ----------------------
// Constants
// ----------------------

// Blank state for the single-patient form
const BLANK_SINGLE_INPUTS: SingleInputs = {
  age: "",
  sex: "",
  smoker: "",
  symptomDurationMonths: "",
  mJOA: "",
  severity: "",
  t2Signal: "",
  levelsOperated: "",
  canalOccupyingRatio: "",
  opll: "",
  t1Hypo: "",
  smokerFlag: "",
  psychDisorder: "",
  gaitImpairment: "",
  baselineNDI: "",
  sf36PCS: "",
  sf36MCS: "",
} as any; // we overwrite smokerFlag immediately in normalize; cast to any to satisfy TS

// Helper: clamp 0–100
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const clamp100 = (x: number) => Math.min(100, Math.max(0, x));

// ----------------------
// Engine – hybrid rules + pseudo-ML
// ----------------------

function autoSeverityFromMJOA(raw: string): Severity | null {
  const val = parseFloat(raw);
  if (Number.isNaN(val)) return null;
  if (val >= 15) return "mild";
  if (val >= 12) return "moderate";
  return "severe";
}

function normalizeSingleInputs(inputs: SingleInputs) {
  const age = parseFloat(inputs.age || "0") || 0;
  const smoker = inputs.smoker === "1" ? 1 : 0;
  const symptomDurationMonths = parseFloat(inputs.symptomDurationMonths || "0") || 0;
  const baseline_mJOA = parseFloat(inputs.mJOA || "0") || 0;
  const levels_operated = parseInt(inputs.levelsOperated || "0", 10) || 0;
  const opll = inputs.opll === "1" ? 1 : 0;
  const t1 = inputs.t1Hypo === "1" ? 1 : 0;
  const gait = inputs.gaitImpairment === "1" ? 1 : 0;
  const psych = inputs.psychDisorder === "1" ? 1 : 0;
  const baseline_NDI = parseFloat(inputs.baselineNDI || "0") || 0;
  const baseline_SF36_PCS = parseFloat(inputs.sf36PCS || "0") || 0;
  const baseline_SF36_MCS = parseFloat(inputs.sf36MCS || "0") || 0;

  const sev: Severity =
    (inputs.severity as Severity) ||
    autoSeverityFromMJOA(inputs.mJOA) ||
    "moderate";

  return {
    age,
    sex: inputs.sex || "M",
    smoker,
    symptomDurationMonths,
    severity: sev,
    baseline_mJOA,
    levels_operated,
    OPLL: opll,
    canal_occupying_ratio_cat: inputs.canalOccupyingRatio || "<50%",
    T2_signal: inputs.t2Signal || "none",
    T1_hypointensity: t1,
    gait_impairment: gait,
    psych_disorder: psych,
    baseline_NDI,
    baseline_SF36_PCS,
    baseline_SF36_MCS,
  };
}

function computeHybridSurgeryProb(x: ReturnType<typeof normalizeSingleInputs>) {
  // Literature-inspired rule component
  let baseRule =
    x.severity === "mild" ? 0.3 : x.severity === "moderate" ? 0.7 : 0.9;

  if (x.symptomDurationMonths >= 12) baseRule += 0.1;
  if (x.symptomDurationMonths >= 36) baseRule += 0.05;
  if (x.T2_signal === "focal" || x.T2_signal === "multilevel") baseRule += 0.1;
  if (x.OPLL === 1) baseRule += 0.05;

  const pRule = clamp01(baseRule);

  // Pseudo-ML component: favor surgery with higher risk markers
  let pML = 0.6;
  if (x.severity === "mild") pML = 0.45;
  if (x.severity === "moderate") pML = 0.75;
  if (x.severity === "severe") pML = 0.9;
  if (x.T2_signal === "multilevel") pML += 0.05;
  if (x.OPLL === 1) pML += 0.05;
  if (x.baseline_mJOA < 12) pML += 0.05;

  pML = clamp01(pML);

  const pCombined = clamp01(0.5 * pRule + 0.5 * pML);
  return { pRule, pML, pCombined };
}

function computeMCIDProb(x: ReturnType<typeof normalizeSingleInputs>): number {
  // Very rough: better severity & shorter duration → higher MCID chance
  let p = 0.7;
  if (x.severity === "mild") p = 0.85;
  if (x.severity === "moderate") p = 0.65;
  if (x.severity === "severe") p = 0.35;

  if (x.symptomDurationMonths > 24) p -= 0.15;
  if (x.symptomDurationMonths > 48) p -= 0.1;
  if (x.T2_signal === "multilevel") p -= 0.1;
  if (x.T1_hypointensity === 1) p -= 0.1;
  if (x.psych_disorder === 1) p -= 0.05;

  return clamp01(p);
}

function computeRiskScore(x: ReturnType<typeof normalizeSingleInputs>): number {
  let score = x.severity === "mild" ? 25 : x.severity === "moderate" ? 55 : 80;

  if (x.T2_signal === "focal") score += 5;
  if (x.T2_signal === "multilevel") score += 10;
  if (x.OPLL === 1) score += 5;
  if (x.symptomDurationMonths > 24) score += 5;
  if (x.symptomDurationMonths > 48) score += 5;

  return clamp100(score);
}

function computeBenefitScore(pMCID: number, severity: Severity): number {
  // Adjust benefit by severity (mild = lower gain, severe = ceiling effect)
  let multiplier = 1;
  if (severity === "mild") multiplier = 0.9;
  if (severity === "moderate") multiplier = 1.0;
  if (severity === "severe") multiplier = 0.7;

  return clamp100(Math.round(pMCID * 100 * multiplier));
}

function computeApproachProbs(
  x: ReturnType<typeof normalizeSingleInputs>
): ApproachProbs {
  // Rule-based “prior”
  let ant = 0.3;
  let post = 0.6;
  let circ = 0.1;

  const longConstruct = x.levels_operated >= 4;
  const heavyOPLL = x.OPLL === 1 || x.canal_occupying_ratio_cat === ">60%";
  const multilevelSignal = x.T2_signal === "multilevel";

  if (x.levels_operated <= 2 && !heavyOPLL && !multilevelSignal) {
    ant = 0.6;
    post = 0.3;
    circ = 0.1;
  }

  if (longConstruct || heavyOPLL || multilevelSignal) {
    post += 0.1;
    circ += 0.1;
    ant -= 0.2;
  }

  if (x.severity === "severe" && heavyOPLL && multilevelSignal) {
    post = 0.35;
    circ = 0.55;
    ant = 0.1;
  }

  // Normalize
  const s = ant + post + circ || 1;
  return {
    anterior: ant / s,
    posterior: post / s,
    circumferential: circ / s,
  };
}

function computeUncertaintyLevel(probs: ApproachProbs): UncertaintyLevel {
  const vals = Object.values(probs);
  const max = Math.max(...vals);
  const second = vals.sort((a, b) => b - a)[1] ?? 0;

  const diff = max - second;
  if (diff >= 0.25) return "low";
  if (diff >= 0.1) return "moderate";
  return "high";
}

function buildSingleResult(inputs: SingleInputs): SingleResult {
  const x = normalizeSingleInputs(inputs);
  const { pRule, pML, pCombined } = computeHybridSurgeryProb(x);
  const pMCID = computeMCIDProb(x);
  const riskScore = computeRiskScore(x);
  const benefitScore = computeBenefitScore(pMCID, x.severity);
  const approachProbs = computeApproachProbs(x);
  const uncertaintyLevel = computeUncertaintyLevel(approachProbs);

  const surgeryRecommended = pCombined >= 0.5;

  let recommendationLabel = "";
  if (!surgeryRecommended) {
    recommendationLabel =
      "Non-operative trial reasonable with close follow-up and structured surveillance.";
  } else if (x.severity === "mild") {
    recommendationLabel = "Consider surgery / surgery likely beneficial.";
  } else {
    recommendationLabel = "Surgery recommended.";
  }

  const riskText =
    x.severity === "mild"
      ? "Mild DCM with some long-term risk of neurologic progression. This score reflects guideline-based progression risk and modeled favorability towards surgery."
      : x.severity === "moderate"
      ? "Moderate DCM with meaningful risk of neurologic worsening without decompression. Score integrates clinical and MRI markers plus modeled risk."
      : "Severe DCM with high risk of further irreversible neurologic injury without decompression. Score reflects high progression risk in the literature plus modeled risk.";

  const benefitText =
    "Estimated probability of achieving clinically meaningful mJOA improvement, combining severity, duration, MRI surrogates, and comorbidity patterns.";

  // Best approach = argmax
  const entries: { key: ApproachKey; val: number }[] = [
    { key: "anterior", val: approachProbs.anterior },
    { key: "posterior", val: approachProbs.posterior },
    { key: "circumferential", val: approachProbs.circumferential },
  ];
  entries.sort((a, b) => b.val - a.val);
  const bestApproach = entries[0].key;

  return {
    normalizedInput: x,
    pSurgeryCombined: pCombined,
    pSurgeryRule: pRule,
    pSurgeryML: pML,
    pMCID_mJOA: pMCID,
    surgeryRecommended,
    recommendationLabel,
    riskScore,
    benefitScore,
    riskText,
    benefitText,
    approachProbs,
    bestApproach,
    uncertaintyLevel,
  };
}

// ----------------------
// Simple PDF generator
// ----------------------

function downloadSinglePDF(result: SingleResult) {
  const doc = new jsPDF();

  doc.setFontSize(14);
  doc.text(
    "Degenerative Cervical Myelopathy Decision-Support Summary",
    10,
    15
  );

  doc.setFontSize(11);
  doc.text("Patient inputs", 10, 25);
  const x = result.normalizedInput;
  const lines1 = [
    `Age: ${x.age}   Sex: ${x.sex}   Smoker: ${x.smoker ? "Yes" : "No"}`,
    `mJOA: ${x.baseline_mJOA.toFixed(1)}   Severity: ${x.severity}`,
    `Duration: ${x.symptomDurationMonths.toFixed(1)} months`,
    `Levels planned: ${x.levels_operated}`,
    `T2 signal: ${x.T2_signal}, T1 hypointensity: ${
      x.T1_hypointensity ? "Yes" : "No"
    }`,
    `OPLL: ${x.OPLL ? "Yes" : "No"}   COR: ${x.canal_occupying_ratio_cat}`,
  ];
  lines1.forEach((l, i) => doc.text(l, 10, 33 + i * 5));

  const pSurg = Math.round(result.pSurgeryCombined * 100);
  const pMCID = Math.round(result.pMCID_mJOA * 100);

  doc.text("Surgery decision", 10, 65);
  const lines2 = [
    `P(surgery favored): ${pSurg}%`,
    `Recommendation: ${result.recommendationLabel}`,
    `Risk score (no surgery): ${result.riskScore}/100`,
    `Benefit score (with surgery): ${result.benefitScore}/100`,
    `P(MCID in mJOA): ${pMCID}%`,
  ];
  lines2.forEach((l, i) => doc.text(l, 10, 73 + i * 5));

  doc.text("Approach modeling", 10, 103);
  const ap = result.approachProbs;
  const lines3 = [
    `Approach probabilities (if surgery chosen):`,
    `Anterior: ${Math.round(ap.anterior * 100)}%`,
    `Posterior: ${Math.round(ap.posterior * 100)}%`,
    `Circumferential: ${Math.round(ap.circumferential * 100)}%`,
    `Model-favored approach: ${result.bestApproach.toUpperCase()}`,
    `Uncertainty: ${result.uncertaintyLevel.toUpperCase()}`,
  ];
  lines3.forEach((l, i) => doc.text(l, 10, 111 + i * 5));

  doc.save("dcm_decision_support_summary.pdf");
}

// ----------------------
// UI Components
// ----------------------

function RiskBenefitDial({ risk, benefit }: { risk: number; benefit: number }) {
  const total = risk + benefit || 1;
  const riskPct = Math.round((risk / total) * 100);
  const benefitPct = 100 - riskPct;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-600">
        <span>Rel. risk without surgery</span>
        <span>Rel. benefit with surgery</span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full bg-rose-500"
          style={{ width: `${riskPct}%` }}
        />
        <div
          className="h-full -mt-3 bg-emerald-500"
          style={{ width: `${benefitPct}%` }}
        />
      </div>
      <div className="flex justify-between text-xs">
        <span className="text-rose-600">{riskPct}%</span>
        <span className="text-emerald-600">{benefitPct}%</span>
      </div>
    </div>
  );
}

function ConfidenceBands({
  probs,
  uncertaintyLevel,
}: {
  probs: ApproachProbs;
  uncertaintyLevel: UncertaintyLevel;
}) {
  const bands: { key: ApproachKey; label: string; value: number }[] = [
    { key: "anterior", label: "Anterior", value: probs.anterior },
    { key: "posterior", label: "Posterior", value: probs.posterior },
    { key: "circumferential", label: "Circumferential", value: probs.circumferential },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-700">
          Approach probability bands
        </span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
          Uncertainty:{" "}
          <span
            className={
              uncertaintyLevel === "low"
                ? "text-emerald-700"
                : uncertaintyLevel === "moderate"
                ? "text-amber-700"
                : "text-rose-700"
            }
          >
            {uncertaintyLevel}
          </span>
        </span>
      </div>
      <div className="space-y-2">
        {bands.map((b) => {
          const pct = Math.round(b.value * 100);
          return (
            <div key={b.key} className="space-y-1">
              <div className="flex justify-between text-xs text-slate-600">
                <span>{b.label}</span>
                <span>{pct}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={
                    b.key === "anterior"
                      ? "h-full bg-sky-500"
                      : b.key === "posterior"
                      ? "h-full bg-indigo-500"
                      : "h-full bg-amber-500"
                  }
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-500">
        Uncertainty reflects how close the modeled approach probabilities are
        to each other. High uncertainty suggests that multiple approaches may
        be reasonable and clinical judgment should dominate.
      </p>
    </div>
  );
}

// ----------------------
// Main Page Component
// ----------------------

export default function PrototypePage() {
  const [singleInputs, setSingleInputs] =
    useState<SingleInputs>(BLANK_SINGLE_INPUTS);
  const [singleResult, setSingleResult] = useState<SingleResult | null>(null);
  const [singleLoading, setSingleLoading] = useState(false);
  const [singleError, setSingleError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<"single" | "batch">("single");
  const [batchFileName, setBatchFileName] = useState<string | null>(null);
  const [batchResults, setBatchResults] = useState<BatchRowResult[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);

  // ---- Handlers: single patient ----

  const updateInput = (field: keyof SingleInputs, value: string) => {
    setSingleInputs((prev) => ({
      ...prev,
      [field]: value,
      ...(field === "mJOA"
        ? {
            severity:
              autoSeverityFromMJOA(value) ??
              (prev.severity as Severity | "") ??
              "",
          }
        : {}),
    }));
  };

  const handleRunSingle = () => {
    setSingleError(null);
    setSingleLoading(true);
    try {
      const res = buildSingleResult(singleInputs);
      setSingleResult(res);
    } catch (e: any) {
      console.error(e);
      setSingleError("Unable to generate recommendation. Please check inputs.");
      setSingleResult(null);
    } finally {
      setSingleLoading(false);
    }
  };

  const handleResetSingle = () => {
    setSingleInputs(BLANK_SINGLE_INPUTS);
    setSingleResult(null);
    setSingleError(null);
  };

  // ---- Handlers: batch testing ----

  const handleBatchFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBatchFileName(file.name);
    setBatchError(null);
    setBatchLoading(true);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const text = String(evt.target?.result || "");
        const rows = text
          .trim()
          .split(/\r?\n/)
          .filter((r) => r.length > 0);
        const header = rows[0].split(",");
        const lowerHeader = header.map((h) => h.trim().toLowerCase());

        const expect = [
          "age",
          "sex",
          "smoker",
          "symptom_duration_months",
          "severity",
          "baseline_mjoa",
          "levels_operated",
          "opll",
          "canal_occupying_ratio_cat",
          "t2_signal",
          "t1_hypointensity",
          "gait_impairment",
          "psych_disorder",
          "baseline_ndi",
          "baseline_sf36_pcs",
          "baseline_sf36_mcs",
        ];

        const missing = expect.filter(
          (col) => !lowerHeader.includes(col.toLowerCase())
        );
        if (missing.length) {
          throw new Error(
            `Missing required columns: ${missing.join(
              ", "
            )}. Please use the sample CSV structure.`
          );
        }

        const idx = Object.fromEntries(
          lowerHeader.map((name, i) => [name, i])
        ) as Record<string, number>;

        const results: BatchRowResult[] = [];
        rows.slice(1).forEach((row, i) => {
          const cols = row.split(",");
          const inp: SingleInputs = {
            age: cols[idx["age"]] ?? "",
            sex: cols[idx["sex"]] ?? "",
            smoker: cols[idx["smoker"]] ?? "",
            symptomDurationMonths: cols[idx["symptom_duration_months"]] ?? "",
            mJOA: cols[idx["baseline_mjoa"]] ?? "",
            severity: cols[idx["severity"]] ?? "",
            t2Signal: cols[idx["t2_signal"]] ?? "",
            levelsOperated: cols[idx["levels_operated"]] ?? "",
            canalOccupyingRatio:
              cols[idx["canal_occupying_ratio_cat"]] ?? "",
            opll: cols[idx["opll"]] ?? "",
            t1Hypo: cols[idx["t1_hypointensity"]] ?? "",
            gaitImpairment: cols[idx["gait_impairment"]] ?? "",
            psychDisorder: cols[idx["psych_disorder"]] ?? "",
            baselineNDI: cols[idx["baseline_ndi"]] ?? "",
            sf36PCS: cols[idx["baseline_sf36_pcs"]] ?? "",
            sf36MCS: cols[idx["baseline_sf36_mcs"]] ?? "",
          };
          const r = buildSingleResult(inp);
          results.push({ ...r, rowIndex: i + 1 });
        });

        setBatchResults(results);
      } catch (err: any) {
        console.error(err);
        setBatchError(
          err?.message ||
            "Unable to process file. Please check format and try again."
        );
        setBatchResults([]);
      } finally {
        setBatchLoading(false);
      }
    };

    reader.readAsText(file);
  };

  const batchSummary = useMemo(() => {
    if (!batchResults.length) return null;
    const n = batchResults.length;
    const nSurg = batchResults.filter((r) => r.surgeryRecommended).length;
    const nNon = n - nSurg;

    const avgRisk =
      batchResults.reduce((sum, r) => sum + r.riskScore, 0) / n || 0;
    const avgBenefit =
      batchResults.reduce((sum, r) => sum + r.benefitScore, 0) / n || 0;

    const approachCounts: Record<ApproachKey, number> = {
      anterior: 0,
      posterior: 0,
      circumferential: 0,
    };
    batchResults.forEach((r) => {
      approachCounts[r.bestApproach] += 1;
    });

    return {
      n,
      nSurg,
      nNon,
      avgRisk: Math.round(avgRisk),
      avgBenefit: Math.round(avgBenefit),
      approachCounts,
    };
  }, [batchResults]);

  // ---------------------- UI ----------------------

  return (
    <main className="min-h-screen bg-slate-50 px-4 pb-16 pt-6 text-slate-900 md:px-8">
      {/* Top bar */}
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <Link
          href="/"
          className="inline-flex items-center text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back
        </Link>
        <div className="flex items-center gap-3">
          <BarChart3 className="h-5 w-5 text-emerald-600" />
          <div className="flex flex-col items-end">
            <span className="text-xs font-medium tracking-wide text-slate-500">
              Degenerative Cervical Myelopathy
            </span>
            <span className="text-sm font-semibold text-slate-800">
              Decision-Support Prototype
            </span>
          </div>
        </div>
      </div>

      {/* Header: logo + title */}
      <div className="mx-auto mt-6 flex max-w-5xl flex-col items-center gap-3 rounded-2xl bg-white/80 p-5 shadow-sm ring-1 ring-slate-100">
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center justify-center rounded-2xl bg-slate-900/90 px-4 py-3 shadow-md">
            {/* Logo image – make sure /public/ascension-seton-logo.png exists */}
            <img
              src="/ascension-seton-logo.png"
              alt="Ascension Logo"
              className="h-10 w-auto object-contain mix-blend-multiply brightness-110 contrast-110"
            />
          </div>
          <h1 className="mt-1 text-center text-xl font-semibold tracking-tight text-slate-900 md:text-2xl">
            Degenerative Cervical Myelopathy Decision-Support Tool
          </h1>
          <p className="max-w-3xl text-center text-xs md:text-sm text-slate-600">
            Combines guideline-inspired rules with a prototype probabilistic
            model to summarize
            <span className="font-medium"> surgery timing</span>{" "}
            and <span className="font-medium">approach trade-offs</span>. Not a
            substitute for clinical judgment.
          </p>
        </div>
      </div>

      {/* Main content */}
      <div className="mx-auto mt-8 flex max-w-5xl flex-col gap-6 md:flex-row">
        {/* Left: inputs & controls */}
        <div className="flex-1 space-y-5">
          {/* Tabs */}
          <div className="inline-flex rounded-full bg-slate-100 p-1 text-xs">
            <button
              type="button"
              className={`rounded-full px-3 py-1.5 ${
                activeTab === "single"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500"
              }`}
              onClick={() => setActiveTab("single")}
            >
              Single patient
            </button>
            <button
              type="button"
              className={`rounded-full px-3 py-1.5 ${
                activeTab === "batch"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500"
              }`}
              onClick={() => setActiveTab("batch")}
            >
              Batch (CSV)
            </button>
          </div>

          {/* Single patient card */}
          {activeTab === "single" && (
            <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
              <div className="mb-4 flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg md:text-xl font-semibold text-emerald-800">
                    1. Should this patient undergo surgery?
                  </h2>
                  <p className="mt-1 text-xs md:text-sm text-slate-600">
                    Enter key baseline variables. Severity will auto-populate
                    from mJOA if left blank. The model summarizes the expected
                    risk without surgery and likelihood of clinically meaningful
                    improvement with surgery.
                  </p>
                </div>
              </div>

              {/* Inputs */}
              <div className="grid grid-cols-2 gap-3 text-xs md:text-sm">
                {/* Col 1 */}
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-700">
                      Age (years)
                    </label>
                    <input
                      className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                      value={singleInputs.age}
                      onChange={(e) => updateInput("age", e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-700">
                      Sex
                    </label>
                    <select
                      className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                      value={singleInputs.sex}
                      onChange={(e) => updateInput("sex", e.target.value)}
                    >
                      <option value="">Select</option>
                      <option value="M">Male</option>
                      <option value="F">Female</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-700">
                      Smoker
                    </label>
                    <select
                      className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                      value={singleInputs.smoker}
                      onChange={(e) => updateInput("smoker", e.target.value)}
                    >
                      <option value="">Select</option>
                      <option value="1">Yes</option>
                      <option value="0">No</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-700">
                      Symptom duration (months)
                    </label>
                    <input
                      className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                      value={singleInputs.symptomDurationMonths}
                      onChange={(e) =>
                        updateInput("symptomDurationMonths", e.target.value)
                      }
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-700">
                      Baseline mJOA
                    </label>
                    <input
                      className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                      value={singleInputs.mJOA}
                      onChange={(e) => updateInput("mJOA", e.target.value)}
                    />
                    <p className="mt-1 text-[10px] text-slate-500">
                      Severity auto-derived if not manually specified.
                    </p>
                  </div>
                </div>

                {/* Col 2 */}
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-700">
                      Severity (mild / moderate / severe)
                    </label>
                    <select
                      className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                      value={singleInputs.severity}
                      onChange={(e) => updateInput("severity", e.target.value)}
                    >
                      <option value="">Auto from mJOA</option>
                      <option value="mild">Mild</option>
                      <option value="moderate">Moderate</option>
                      <option value="severe">Severe</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-700">
                      T2 cord signal
                    </label>
                    <select
                      className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                      value={singleInputs.t2Signal}
                      onChange={(e) => updateInput("t2Signal", e.target.value)}
                    >
                      <option value="">Select</option>
                      <option value="none">None</option>
                      <option value="focal">Focal</option>
                      <option value="multilevel">Multilevel</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-700">
                      Levels planned
                    </label>
                    <input
                      className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                      value={singleInputs.levelsOperated}
                      onChange={(e) =>
                        updateInput("levelsOperated", e.target.value)
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-700">
                        OPLL
                      </label>
                      <select
                        className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                        value={singleInputs.opll}
                        onChange={(e) => updateInput("opll", e.target.value)}
                      >
                        <option value="">Select</option>
                        <option value="1">Present</option>
                        <option value="0">Absent</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-700">
                        Canal occupying ratio
                      </label>
                      <select
                        className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                        value={singleInputs.canalOccupyingRatio}
                        onChange={(e) =>
                          updateInput("canalOccupyingRatio", e.target.value)
                        }
                      >
                        <option value="&lt;50%">&lt;50%</option>
                        <option value="50-60%">50–60%</option>
                        <option value="&gt;60%">&gt;60%</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-700">
                        T1 hypointensity
                      </label>
                      <select
                        className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                        value={singleInputs.t1Hypo}
                        onChange={(e) => updateInput("t1Hypo", e.target.value)}
                      >
                        <option value="">Select</option>
                        <option value="1">Present</option>
                        <option value="0">Absent</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-700">
                        Gait impairment
                      </label>
                      <select
                        className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                        value={singleInputs.gaitImpairment}
                        onChange={(e) =>
                          updateInput("gaitImpairment", e.target.value)
                        }
                      >
                        <option value="">Select</option>
                        <option value="1">Yes</option>
                        <option value="0">No</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-700">
                        Psych disorder
                      </label>
                      <select
                        className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                        value={singleInputs.psychDisorder}
                        onChange={(e) =>
                          updateInput("psychDisorder", e.target.value)
                        }
                      >
                        <option value="">Select</option>
                        <option value="1">Yes</option>
                        <option value="0">No</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-700">
                        Baseline NDI
                      </label>
                      <input
                        className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                        value={singleInputs.baselineNDI}
                        onChange={(e) =>
                          updateInput("baselineNDI", e.target.value)
                        }
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-700">
                        SF-36 PCS
                      </label>
                      <input
                        className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                        value={singleInputs.sf36PCS}
                        onChange={(e) =>
                          updateInput("sf36PCS", e.target.value)
                        }
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-slate-700">
                        SF-36 MCS
                      </label>
                      <input
                        className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs md:text-sm"
                        value={singleInputs.sf36MCS}
                        onChange={(e) =>
                          updateInput("sf36MCS", e.target.value)
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Buttons */}
              <div className="mt-6 flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleRunSingle}
                  disabled={singleLoading}
                  className="inline-flex items-center rounded-full bg-emerald-600 px-5 py-2 text-xs md:text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
                >
                  {singleLoading && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Run recommendation
                </button>
                <button
                  type="button"
                  onClick={handleResetSingle}
                  className="inline-flex items-center rounded-full border border-slate-200 bg-white px-4 py-2 text-xs md:text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Reset
                </button>
                {singleResult && (
                  <button
                    type="button"
                    onClick={() => downloadSinglePDF(singleResult)}
                    className="inline-flex items-center rounded-full border border-slate-200 bg-white px-4 py-2 text-xs md:text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <FileDown className="mr-1.5 h-4 w-4" />
                    Download 1-page PDF
                  </button>
                )}
              </div>

              {singleError && (
                <p className="mt-3 text-xs text-rose-600">{singleError}</p>
              )}
            </section>
          )}

          {/* Batch card */}
          {activeTab === "batch" && (
            <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg md:text-xl font-semibold text-slate-900">
                    Batch testing (100+ patients)
                  </h2>
                  <p className="mt-1 text-xs md:text-sm text-slate-600">
                    Upload a CSV with one row per patient. The engine will
                    summarize proportions of patients with surgery
                    recommendations and which approaches are favored if surgery
                    is ultimately chosen.
                  </p>
                </div>
              </div>

              <div className="mt-3 space-y-3 text-xs md:text-sm">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-700">
                    Upload CSV
                  </label>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleBatchFile}
                    className="block w-full text-xs md:text-sm text-slate-700"
                  />
                  {batchFileName && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      Loaded file: {batchFileName}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-slate-500">
                    Required columns (header row): age, sex, smoker,
                    symptom_duration_months, severity, baseline_mJOA,
                    levels_operated, OPLL, canal_occupying_ratio_cat, T2_signal,
                    T1_hypointensity, gait_impairment, psych_disorder,
                    baseline_NDI, baseline_SF36_PCS, baseline_SF36_MCS.
                  </p>
                </div>

                {batchLoading && (
                  <p className="flex items-center text-xs text-slate-600">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Running batch through the engine…
                  </p>
                )}

                {batchError && (
                  <p className="text-xs text-rose-600">{batchError}</p>
                )}

                {batchSummary && (
                  <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs md:text-sm">
                    <div className="mb-2 flex items-center gap-2">
                      <Info className="h-4 w-4 text-slate-500" />
                      <span className="font-medium text-slate-800">
                        Batch summary ({batchSummary.n} patients)
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[11px] text-slate-500">
                          Surgery recommendation
                        </p>
                        <p className="text-sm font-semibold text-slate-900">
                          {batchSummary.nSurg} surgery, {batchSummary.nNon}{" "}
                          non-operative
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-500">
                          Avg. risk / benefit scores
                        </p>
                        <p className="text-sm font-semibold text-slate-900">
                          Risk {batchSummary.avgRisk}/100, Benefit{" "}
                          {batchSummary.avgBenefit}/100
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-3 text-[11px] text-slate-600">
                      <div>
                        <span className="font-medium text-slate-800">
                          Favored anterior:
                        </span>{" "}
                        {batchSummary.approachCounts.anterior}
                      </div>
                      <div>
                        <span className="font-medium text-slate-800">
                          Favored posterior:
                        </span>{" "}
                        {batchSummary.approachCounts.posterior}
                      </div>
                      <div>
                        <span className="font-medium text-slate-800">
                          Favored circumferential:
                        </span>{" "}
                        {batchSummary.approachCounts.circumferential}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>

        {/* Right: outputs for single patient */}
        <div className="flex-1 space-y-5">
          {/* Card 1: surgery decision */}
          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg md:text-xl font-semibold text-slate-900">
                  1. Should this patient undergo surgery?
                </h2>
                <p className="mt-1 text-xs md:text-sm text-slate-600">
                  Probability and narrative summary of surgery vs structured
                  non-operative management, integrating severity, duration, and
                  MRI risk surrogates.
                </p>
              </div>
            </div>

            {!singleResult && (
              <p className="text-xs text-slate-500">
                Enter patient inputs on the left and click{" "}
                <span className="font-semibold">“Run recommendation”</span> to
                view modeled estimates.
              </p>
            )}

            {singleResult && (
              <div className="space-y-4 text-xs md:text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">
                      Modeled surgery favorability
                    </p>
                    <p className="mt-1 text-base md:text-lg font-semibold text-slate-900">
                      {Math.round(singleResult.pSurgeryCombined * 100)}% chance
                      surgery is favored over long-term non-operative care
                    </p>
                    <p className="mt-1 text-xs md:text-sm text-slate-700">
                      Recommendation:{" "}
                      <span className="font-semibold">
                        {singleResult.recommendationLabel}
                      </span>
                    </p>
                  </div>
                </div>

                <RiskBenefitDial
                  risk={singleResult.riskScore}
                  benefit={singleResult.benefitScore}
                />

                <div className="mt-2 space-y-1 text-[11px] text-slate-600">
                  <p>
                    <span className="font-semibold text-slate-800">Risk:</span>{" "}
                    {singleResult.riskText}
                  </p>
                  <p>
                    <span className="font-semibold text-slate-800">
                      Benefit:
                    </span>{" "}
                    {singleResult.benefitText}
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* Card 2: approach */}
          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg md:text-xl font-semibold text-slate-900">
                  2. If surgery is offered, which approach?
                </h2>
                <p className="mt-1 text-xs md:text-sm text-slate-600">
                  Approach modeling is shown even when a non-operative path is
                  preferred, to support discussion and planning. Probabilities
                  reflect a prototype balance of guideline concepts and modeled
                  outcomes; final choice should be individualized.
                </p>
              </div>
            </div>

            {!singleResult && (
              <p className="text-xs text-slate-500">
                After running a recommendation, this section will display the
                model’s favored approach and uncertainty bands. When surgery is
                not recommended, interpret this as{" "}
                <span className="italic">
                  “If surgery is ultimately chosen…”
                </span>
                .
              </p>
            )}

            {singleResult && (
              <div className="space-y-4 text-xs md:text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-slate-500">
                      Model-favored approach (if surgery chosen)
                    </p>
                    <p className="mt-1 text-base md:text-lg font-semibold text-slate-900">
                      {singleResult.bestApproach.toUpperCase()}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      This reflects the highest modeled probability of
                      clinically meaningful mJOA improvement among anterior,
                      posterior, or circumferential options for this input
                      pattern.
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                    <p className="flex items-center gap-1">
                      <Info className="h-3.5 w-3.5 text-slate-500" />
                      <span>
                        When the tool recommends a{" "}
                        <span className="font-semibold">non-operative</span>{" "}
                        trial, approach probabilities should be interpreted as
                        conditional: *if* surgery is later pursued, this is the
                        predicted relative ranking, not a directive.
                      </span>
                    </p>
                  </div>
                </div>

                <ConfidenceBands
                  probs={singleResult.approachProbs}
                  uncertaintyLevel={singleResult.uncertaintyLevel}
                />
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
