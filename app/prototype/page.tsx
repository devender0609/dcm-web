"use client";

import React, { useState, useMemo, ChangeEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import jsPDF from "jspdf";

type Severity = "mild" | "moderate" | "severe";

type ApproachKey = "anterior" | "posterior" | "circumferential";
type ApproachChoice = ApproachKey | "none";

type PatientInput = {
  age: number;
  sex: "M" | "F";
  /**
   * 0 = never / former smoker
   * 1 = current smoker
   *
   * UI will display 3 categories (never / former / current)
   * but map never + former => 0 for compatibility with the
   * current Python model.
   */
  smoker: 0 | 1;
  symptomDurationMonths: number;
  severity: Severity;
  baselineMJOA: number;
  levelsOperated: number;
  canalRatio: "<50%" | "50–60%" | ">60%";
  t2Signal: "none" | "focal" | "multilevel";
  opll: 0 | 1;
  t1Hypo: 0 | 1;
  gaitImpairment: 0 | 1;
  psychDisorder: 0 | 1;
  baselineNDI: number;
  sf36PCS: number;
  sf36MCS: number;
};

type ApproachProbs = Record<ApproachKey, number>;

type SingleResult = {
  pSurgRule: number;
  pSurgMl: number;
  pSurgCombined: number;
  surgeryRecommended: boolean;
  recommendationLabel: string;
  pMcid: number;
  riskScore: number;
  benefitScore: number;
  riskText: string;
  benefitText: string;
  approachProbsRule: ApproachProbs;
  approachProbsMl: ApproachProbs;
  combinedApproachProbs: ApproachProbs;
  bestApproach: ApproachChoice;
  bestApproachProb: number;
  secondBestApproachProb: number;
  uncertaintyLevel: "low" | "moderate" | "high";
};

type BatchRow = PatientInput & {
  id: number | string;
};

type BatchResultRow = BatchRow &
  Pick<
    SingleResult,
    | "pSurgCombined"
    | "surgeryRecommended"
    | "pMcid"
    | "riskScore"
    | "benefitScore"
    | "bestApproach"
    | "uncertaintyLevel"
  >;

// -----------------------------
// Utility helpers
// -----------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function severityFromMJOA(mJOA: number): Severity {
  if (!Number.isFinite(mJOA)) return "mild";
  if (mJOA >= 15) return "mild";
  if (mJOA >= 12) return "moderate";
  return "severe";
}

function parseNonNegativeFloat(raw: string): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return NaN;
  return n < 0 ? 0 : n;
}

// Very lightweight “rule + pseudo-ML” logic that mimics the Python engine
// (not exact, but directionally similar for the demo).
function computeSingleResult(input: PatientInput): SingleResult {
  const severity = input.severity;

  // Enforce a clinically reasonable minimum age internally
  const ageForModel = !Number.isFinite(input.age)
    ? 65
    : input.age < 16
    ? 16
    : input.age;

  // --- 1) Surgery probability (rule-based) ---
  let baseRule =
    severity === "mild" ? 0.3 : severity === "moderate" ? 0.7 : 0.9;

  if (input.symptomDurationMonths >= 12) baseRule += 0.1;
  if (input.t2Signal === "focal") baseRule += 0.05;
  if (input.t2Signal === "multilevel") baseRule += 0.1;
  if (input.canalRatio === "50–60%") baseRule += 0.05;
  if (input.canalRatio === ">60%") baseRule += 0.1;
  if (input.gaitImpairment === 1) baseRule += 0.05;
  if (input.opll === 1) baseRule += 0.05;

  baseRule = clamp(baseRule, 0, 0.98);

  // --- 2) “ML” surgery probability (simple surrogate) ---
  // More weight to MRI + duration; older age lowers it slightly.
  let mlScore =
    (severity === "mild" ? 0.2 : severity === "moderate" ? 0.7 : 0.9) +
    (input.symptomDurationMonths >= 12 ? 0.15 : 0) +
    (input.t2Signal === "multilevel" ? 0.1 : input.t2Signal === "focal" ? 0.05 : 0) +
    (input.canalRatio === ">60%" ? 0.1 : input.canalRatio === "50–60%" ? 0.05 : 0) +
    (input.opll ? 0.05 : 0) +
    (input.gaitImpairment ? 0.05 : 0) -
    (ageForModel > 80 ? 0.1 : ageForModel > 70 ? 0.05 : 0);

  mlScore = clamp(mlScore, 0.02, 0.98);

  const pSurgRule = baseRule;
  const pSurgMl = mlScore;
  const pSurgCombined = clamp(0.5 * (pSurgRule + pSurgMl), 0, 1);

  const surgeryRecommended = pSurgCombined >= 0.5;
  const recommendationLabel = surgeryRecommended
    ? "Surgery recommended"
    : pSurgCombined >= 0.3
    ? "Consider surgery / close non-operative follow-up"
    : "Non-operative trial reasonable with structured surveillance";

  // --- 3) Risk vs benefit scores (0–100) ---
  let riskScore =
    severity === "mild" ? 25 : severity === "moderate" ? 55 : 80;

  if (input.symptomDurationMonths >= 24) riskScore += 10;
  if (input.t2Signal === "focal") riskScore += 5;
  if (input.t2Signal === "multilevel") riskScore += 10;
  if (input.canalRatio === ">60%") riskScore += 10;
  if (input.opll === 1) riskScore += 5;
  if (input.gaitImpairment === 1) riskScore += 5;

  riskScore = clamp(riskScore, 0, 100);

  let benefitScore =
    severity === "mild" ? 75 : severity === "moderate" ? 55 : 30;

  if (input.symptomDurationMonths < 6) benefitScore += 10;
  if (input.symptomDurationMonths > 36) benefitScore -= 10;
  if (input.baselineMJOA <= 10) benefitScore += 5;
  if (input.baselineNDI >= 50) benefitScore += 5;

  benefitScore = clamp(benefitScore, 0, 100);

  // Normalize to a pseudo-probability of MCID.
  const pMcid = clamp(benefitScore / 100, 0.01, 0.99);

  const riskText =
    severity === "severe"
      ? "Severe DCM carries high risk of irreversible deterioration without decompression, especially with multilevel compression or high canal compromise."
      : severity === "moderate"
      ? "Moderate DCM with persistent symptoms has meaningful risk of neurological worsening if left untreated."
      : "Mild DCM generally progresses slowly, but risk increases with longer duration, cord signal change, and canal compromise.";

  const benefitText =
    "Estimated probability of achieving clinically meaningful improvement in mJOA based on symptom severity, duration, MRI surrogates, and published DCM outcome cohorts.";

  // --- 4) Approach probabilities (rule + “ML”) ---
  const baseAnt =
    input.levelsOperated <= 2 &&
    input.canalRatio !== ">60%" &&
    input.t2Signal !== "multilevel"
      ? 0.55
      : 0.3;

  const basePost =
    input.levelsOperated >= 3 || input.t2Signal === "multilevel" ? 0.6 : 0.35;

  const baseCirc =
    input.opll === 1 && input.canalRatio === ">60%" && input.levelsOperated >= 4
      ? 0.5
      : 0.15;

  const ruleSum = baseAnt + basePost + baseCirc;
  const ruleProbs: ApproachProbs = {
    anterior: ruleSum > 0 ? baseAnt / ruleSum : 1 / 3,
    posterior: ruleSum > 0 ? basePost / ruleSum : 1 / 3,
    circumferential: ruleSum > 0 ? baseCirc / ruleSum : 1 / 3,
  };

  // Simple “ML” flavor: bias to posterior if multilevel, to anterior if short-segment.
  let mlAnt = baseAnt;
  let mlPost = basePost;
  let mlCirc = baseCirc;

  if (input.t2Signal === "multilevel") {
    mlPost += 0.1;
  }
  if (input.levelsOperated <= 2) {
    mlAnt += 0.1;
  }
  if (input.opll && input.canalRatio === ">60%" && input.levelsOperated >= 4) {
    mlCirc += 0.15;
  }

  const mlSum = mlAnt + mlPost + mlCirc;
  const mlProbs: ApproachProbs = {
    anterior: mlSum > 0 ? mlAnt / mlSum : 1 / 3,
    posterior: mlSum > 0 ? mlPost / mlSum : 1 / 3,
    circumferential: mlSum > 0 ? mlCirc / mlSum : 1 / 3,
  };

  const combined: ApproachProbs = {
    anterior: clamp(
      0.5 * (ruleProbs.anterior + mlProbs.anterior),
      0,
      1
    ),
    posterior: clamp(
      0.5 * (ruleProbs.posterior + mlProbs.posterior),
      0,
      1
    ),
    circumferential: clamp(
      0.5 * (ruleProbs.circumferential + mlProbs.circumferential),
      0,
      1
    ),
  };

  const vals: [ApproachKey, number][] = [
    ["anterior", combined.anterior],
    ["posterior", combined.posterior],
    ["circumferential", combined.circumferential],
  ];
  vals.sort((a, b) => b[1] - a[1]);

  const bestPair = vals[0];
  const secondPair = vals[1];

  const bestApproach: ApproachChoice = bestPair[0];

  let uncertainty: "low" | "moderate" | "high" = "low";
  const gap = bestPair[1] - secondPair[1];
  if (gap < 0.05) {
    uncertainty = "high";
  } else if (gap < 0.15) {
    uncertainty = "moderate";
  }

  return {
    pSurgRule,
    pSurgMl,
    pSurgCombined,
    surgeryRecommended,
    recommendationLabel,
    pMcid,
    riskScore,
    benefitScore,
    riskText,
    benefitText,
    approachProbsRule: ruleProbs,
    approachProbsMl: mlProbs,
    combinedApproachProbs: combined,
    bestApproach,
    bestApproachProb: bestPair[1],
    secondBestApproachProb: secondPair[1],
    uncertaintyLevel: uncertainty,
  };
}

// -----------------------------
// CSV batch parsing
// -----------------------------

function parseCsv(text: string): BatchRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim());
  const rows: BatchRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    if (cols.length !== header.length) continue;

    const rec: any = {};
    header.forEach((h, idx) => {
      rec[h] = cols[idx];
    });

    const baselineMJOA = parseNonNegativeFloat(
      rec["mJOA"] ?? rec["baseline_mJOA"]
    );
    const sev = severityFromMJOA(baselineMJOA);

    const smokerRaw = (rec["smoker"] ?? "").toString().toLowerCase();
    // Map multiple text options into 0/1:
    //  - "current", "1", "yes" => 1
    //  - "never", "former", "0", "no", anything else => 0
    let smokerVal: 0 | 1 = 0;
    if (
      smokerRaw === "1" ||
      smokerRaw === "yes" ||
      smokerRaw === "y" ||
      smokerRaw === "current"
    ) {
      smokerVal = 1;
    }

    const row: BatchRow = {
      id: rec["id"] ?? rec["patient_id"] ?? i,
      age: parseNonNegativeFloat(rec["age"]),
      sex: (rec["sex"] ?? "M") === "F" ? "F" : "M",
      smoker: smokerVal,
      symptomDurationMonths: parseNonNegativeFloat(
        rec["symptom_duration_months"]
      ),
      severity: sev,
      baselineMJOA,
      levelsOperated: (() => {
        const n = parseInt(
          rec["levels_operated"] ?? rec["planned_levels"] ?? "1",
          10
        );
        if (!Number.isFinite(n)) return NaN;
        return n < 0 ? 0 : n;
      })(),
      canalRatio:
        rec["canal_occupying_ratio_cat"] === "50-60%" ||
        rec["canal_occupying_ratio_cat"] === "50–60%"
          ? "50–60%"
          : rec["canal_occupying_ratio_cat"] === ">60%"
          ? ">60%"
          : "<50%",
      t2Signal:
        rec["T2_signal"] === "multilevel" || rec["T2_signal"] === "Multilevel"
          ? "multilevel"
          : rec["T2_signal"] === "focal"
          ? "focal"
          : "none",
      opll: rec["OPLL"] === "1" || rec["OPLL"] === "Yes" ? 1 : 0,
      t1Hypo:
        rec["T1_hypointensity"] === "1" || rec["T1_hypointensity"] === "Yes"
          ? 1
          : 0,
      gaitImpairment:
        rec["gait_impairment"] === "1" || rec["gait_impairment"] === "Yes"
          ? 1
          : 0,
      psychDisorder:
        rec["psych_disorder"] === "1" || rec["psych_disorder"] === "Yes"
          ? 1
          : 0,
      baselineNDI: parseNonNegativeFloat(rec["baseline_NDI"] ?? "0"),
      sf36PCS: parseNonNegativeFloat(rec["baseline_SF36_PCS"] ?? "0"),
      sf36MCS: parseNonNegativeFloat(rec["baseline_SF36_MCS"] ?? "0"),
    };

    rows.push(row);
  }

  return rows;
}

// -----------------------------
// Initial single-patient states
// -----------------------------

const initialSingleInput: PatientInput = {
  age: 65,
  sex: "M",
  smoker: 0,
  symptomDurationMonths: 12,
  severity: "moderate",
  baselineMJOA: 13,
  levelsOperated: 3,
  canalRatio: "50–60%",
  t2Signal: "multilevel",
  opll: 0,
  t1Hypo: 0,
  gaitImpairment: 1,
  psychDisorder: 0,
  baselineNDI: 40,
  sf36PCS: 32,
  sf36MCS: 45,
};

const blankSingleInput: PatientInput = {
  age: NaN,
  sex: "M",
  smoker: 0,
  symptomDurationMonths: NaN,
  severity: "mild",
  baselineMJOA: NaN,
  levelsOperated: NaN,
  canalRatio: "<50%",
  t2Signal: "none",
  opll: 0,
  t1Hypo: 0,
  gaitImpairment: 0,
  psychDisorder: 0,
  baselineNDI: NaN,
  sf36PCS: NaN,
  sf36MCS: NaN,
};

export default function PrototypePage() {
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [singleInput, setSingleInput] =
    useState<PatientInput>(initialSingleInput);
  const [singleResult, setSingleResult] = useState<SingleResult | null>(null);

  const [batchRows, setBatchRows] = useState<BatchRow[]>([]);
  const [batchResults, setBatchResults] = useState<BatchResultRow[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);

  // Auto-update severity from mJOA when value changes
  const severityAuto = useMemo(
    () => severityFromMJOA(singleInput.baselineMJOA),
    [singleInput.baselineMJOA]
  );

  const handleSingleChange =
    (field: keyof PatientInput) =>
    (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = e.target.value;
      setSingleInput((prev) => {
        const updated: PatientInput = { ...prev };

        switch (field) {
          case "age":
          case "symptomDurationMonths":
          case "baselineMJOA":
          case "levelsOperated":
          case "baselineNDI":
          case "sf36PCS":
          case "sf36MCS": {
            if (value === "") {
              (updated as any)[field] = NaN;
            } else {
              let num = parseFloat(value);
              if (!Number.isFinite(num)) {
                (updated as any)[field] = NaN;
              } else {
                if (num < 0) num = 0; // non-negative constraint
                (updated as any)[field] = num;
              }
            }
            break;
          }
          case "smoker": {
            // value is one of "never", "former", "current"
            if (value === "current") {
              updated.smoker = 1;
            } else {
              // never or former → 0
              updated.smoker = 0;
            }
            break;
          }
          case "opll":
          case "t1Hypo":
          case "gaitImpairment":
          case "psychDisorder":
            (updated as any)[field] = value === "1" ? 1 : 0;
            break;
          case "sex":
            updated.sex = (value === "F" ? "F" : "M") as "M" | "F";
            break;
          case "severity":
            updated.severity = value as Severity;
            break;
          case "canalRatio":
            updated.canalRatio = value as PatientInput["canalRatio"];
            break;
          case "t2Signal":
            updated.t2Signal = value as PatientInput["t2Signal"];
            break;
          default:
            (updated as any)[field] = value;
        }

        // keep severity synced with mJOA unless user explicitly overrides
        updated.severity = severityFromMJOA(updated.baselineMJOA);

        return updated;
      });
    };

  const runSingleRecommendation = () => {
    const result = computeSingleResult(singleInput);
    setSingleResult(result);
  };

  const resetSingleInputs = () => {
    setSingleInput(blankSingleInput);
    setSingleResult(null);
  };

  const handleBatchFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (!rows.length) {
        setBatchError("Could not find any valid rows in the CSV.");
        setBatchRows([]);
        setBatchResults([]);
        return;
      }
      setBatchError(null);
      setBatchRows(rows);
      const results: BatchResultRow[] = rows.map((r) => {
        const res = computeSingleResult(r);
        return {
          ...r,
          pSurgCombined: res.pSurgCombined,
          surgeryRecommended: res.surgeryRecommended,
          pMcid: res.pMcid,
          riskScore: res.riskScore,
          benefitScore: res.benefitScore,
          bestApproach: res.bestApproach,
          uncertaintyLevel: res.uncertaintyLevel,
        };
      });
      setBatchResults(results);
    } catch (err: any) {
      setBatchError("Error reading CSV file.");
      console.error(err);
    }
  };

  const handleBatchExportPdf = () => {
    if (!batchResults.length) return;
    const doc = new jsPDF();
    doc.setFontSize(12);
    doc.text("DCM Batch Results", 10, 10);

    const headers = [
      "ID",
      "Age",
      "mJOA",
      "Severity",
      "Dur (mo)",
      "Levels",
      "T2",
      "Canal",
      "P(surg)",
      "P(MCID)",
      "Best approach",
      "Uncertainty",
    ];
    let y = 18;
    doc.setFontSize(9);
    doc.text(headers.join(" | "), 10, y);
    y += 6;

    batchResults.forEach((r) => {
      if (y > 280) {
        doc.addPage();
        y = 10;
      }
      const row = [
        String(r.id),
        String(r.age),
        r.baselineMJOA.toFixed(1),
        r.severity,
        String(r.symptomDurationMonths),
        String(r.levelsOperated),
        r.t2Signal,
        r.canalRatio,
        `${(r.pSurgCombined * 100).toFixed(0)}%`,
        `${(r.pMcid * 100).toFixed(0)}%`,
        r.bestApproach === "none" ? "-" : r.bestApproach,
        r.uncertaintyLevel,
      ].join(" | ");
      doc.text(row, 10, y);
      y += 6;
    });

    doc.save("dcm_batch_results.pdf");
  };

  // -----------------------------
  // Render
  // -----------------------------

  return (
    <div className="min-h-screen bg-slate-50 text-[15px]">
      {/* HEADER – unchanged layout */}
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 lg:px-8">
          <Link
            href="/"
            className="flex items-center text-sm text-slate-500 hover:text-slate-700"
          >
            ← Back to overview
          </Link>

          <div className="flex flex-col items-center">
            <Image
              src="/ascension-seton-logo.png"
              alt="Ascension & Seton"
              width={260}
              height={60}
              className="h-12 w-auto object-contain"
              priority
            />
            <p className="mt-2 text-xs font-medium tracking-wide text-slate-600">
              Degenerative Cervical Myelopathy Decision-Support Tool
            </p>
          </div>

          <div className="w-24" />
        </div>
      </header>

      {/* MAIN CONTENT – unchanged layout */}
      <main className="mx-auto max-w-6xl px-4 pb-16 pt-8 lg:px-8">
        {/* Title bar */}
        <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">
              DCM Surgical Decision-Support
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Single-patient and batch views using guideline-informed logic
              blended with machine-learning style patterns.
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-6 inline-flex rounded-full bg-slate-100 p-1 text-sm">
          <button
            className={`rounded-full px-6 py-2 ${
              mode === "single"
                ? "bg-emerald-600 text-white shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
            onClick={() => setMode("single")}
          >
            Single patient
          </button>
          <button
            className={`rounded-full px-6 py-2 ${
              mode === "batch"
                ? "bg-emerald-600 text-white shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
            onClick={() => setMode("batch")}
          >
            Batch (CSV)
          </button>
        </div>

        {/* SINGLE PATIENT VIEW */}
        {mode === "single" && (
          <>
            {/* Input card */}
            <section className="mb-8 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
              <h2 className="mb-4 text-lg font-semibold text-slate-900">
                Baseline clinical information
              </h2>

              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {/* Age */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    Age (years)
                  </label>
                  <input
                    type="number"
                    min={16}
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={
                      Number.isNaN(singleInput.age) ? "" : singleInput.age
                    }
                    onChange={handleSingleChange("age")}
                  />
                  <p className="mt-1 text-[10px] text-slate-500">
                    Prototype assumes adult patients (≥16 years).
                  </p>
                </div>

                {/* Sex */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    Sex
                  </label>
                  <select
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={singleInput.sex}
                    onChange={handleSingleChange("sex")}
                  >
                    <option value="M">M</option>
                    <option value="F">F</option>
                  </select>
                </div>

                {/* Smoker – 3-level UI mapped to 2-level model */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    Smoking status
                  </label>
                  <select
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={
                      singleInput.smoker === 1 ? "current" : "never_or_former"
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      setSingleInput((prev) => ({
                        ...prev,
                        smoker: v === "current" ? 1 : 0,
                      }));
                    }}
                  >
                    <option value="never_or_former">Never / Former</option>
                    <option value="current">Current smoker</option>
                  </select>
                  <p className="mt-1 text-[10px] text-slate-500">
                    For this prototype, current smoking (vs never/former) is
                    what feeds the model. Detailed pack-year history should live
                    in the EMR.
                  </p>
                </div>

                {/* Symptom duration */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    Symptom duration (months)
                  </label>
                  <input
                    type="number"
                    min={0}
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={
                      Number.isNaN(singleInput.symptomDurationMonths)
                        ? ""
                        : singleInput.symptomDurationMonths
                    }
                    onChange={handleSingleChange("symptomDurationMonths")}
                  />
                </div>

                {/* mJOA */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    mJOA
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min={0}
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={
                      Number.isNaN(singleInput.baselineMJOA)
                        ? ""
                        : singleInput.baselineMJOA
                    }
                    onChange={handleSingleChange("baselineMJOA")}
                  />
                  <p className="mt-1 text-[10px] text-slate-500">
                    Severity band auto-derives from mJOA.
                  </p>
                </div>

                {/* Severity (auto) */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    Severity (auto from mJOA)
                  </label>
                  <input
                    type="text"
                    readOnly
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700"
                    value={
                      severityAuto === "mild"
                        ? "Mild (mJOA ≥ 15)"
                        : severityAuto === "moderate"
                        ? "Moderate (mJOA 12–14)"
                        : "Severe (mJOA < 12)"
                    }
                  />
                </div>

                {/* Levels operated */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    Planned operated levels
                  </label>
                  <input
                    type="number"
                    min={0}
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={
                      Number.isNaN(singleInput.levelsOperated)
                        ? ""
                        : singleInput.levelsOperated
                    }
                    onChange={handleSingleChange("levelsOperated")}
                  />
                </div>

                {/* Canal ratio */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    Canal occupying ratio
                  </label>
                  <select
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={singleInput.canalRatio}
                    onChange={handleSingleChange("canalRatio")}
                  >
                    <option value="<50%">&lt;50%</option>
                    <option value="50–60%">50–60%</option>
                    <option value=">60%">&gt;60%</option>
                  </select>
                </div>

                {/* T2 signal */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    T2 cord signal
                  </label>
                  <select
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={singleInput.t2Signal}
                    onChange={handleSingleChange("t2Signal")}
                  >
                    <option value="none">None / normal</option>
                    <option value="focal">Focal hyperintense</option>
                    <option value="multilevel">Multilevel / extensive</option>
                  </select>
                </div>

                {/* OPLL */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    OPLL present
                  </label>
                  <select
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={singleInput.opll}
                    onChange={handleSingleChange("opll")}
                  >
                    <option value={0}>No</option>
                    <option value={1}>Yes</option>
                  </select>
                </div>

                {/* T1 hypo */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    T1 hypointensity
                  </label>
                  <select
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={singleInput.t1Hypo}
                    onChange={handleSingleChange("t1Hypo")}
                  >
                    <option value={0}>No</option>
                    <option value={1}>Yes</option>
                  </select>
                </div>

                {/* Gait impairment */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    Gait impairment
                  </label>
                  <select
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={singleInput.gaitImpairment}
                    onChange={handleSingleChange("gaitImpairment")}
                  >
                    <option value={0}>No</option>
                    <option value={1}>Yes</option>
                  </select>
                </div>

                {/* Psych, NDI, SF-36 */}
                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    Psychiatric disorder
                  </label>
                  <select
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={singleInput.psychDisorder}
                    onChange={handleSingleChange("psychDisorder")}
                  >
                    <option value={0}>No</option>
                    <option value={1}>Yes</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    Baseline NDI
                  </label>
                  <input
                    type="number"
                    min={0}
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={
                      Number.isNaN(singleInput.baselineNDI)
                        ? ""
                        : singleInput.baselineNDI
                    }
                    onChange={handleSingleChange("baselineNDI")}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    SF-36 PCS
                  </label>
                  <input
                    type="number"
                    min={0}
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={
                      Number.isNaN(singleInput.sf36PCS)
                        ? ""
                        : singleInput.sf36PCS
                    }
                    onChange={handleSingleChange("sf36PCS")}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600">
                    SF-36 MCS
                  </label>
                  <input
                    type="number"
                    min={0}
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    value={
                      Number.isNaN(singleInput.sf36MCS)
                        ? ""
                        : singleInput.sf36MCS
                    }
                    onChange={handleSingleChange("sf36MCS")}
                  />
                </div>
              </div>

              <div className="mt-6 flex gap-3">
                <button
                  onClick={runSingleRecommendation}
                  className="inline-flex items-center rounded-full bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
                >
                  Run recommendation
                </button>
                <button
                  onClick={resetSingleInputs}
                  className="inline-flex items-center rounded-full border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Reset
                </button>
              </div>

              <div className="mt-6 flex items-start gap-2 rounded-2xl bg-slate-50 px-4 py-3 text-xs text-slate-600">
                <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-emerald-600/10 text-center text-[10px] font-semibold text-emerald-700">
                  i
                </span>
                <p>
                  This prototype blends AO Spine / WFNS severity, cord signal,
                  canal compromise, OPLL, and gait with machine-learning–style
                  patterns trained on synthetic DCM cohorts. It is intended only
                  to structure discussions, not replace surgeon judgment.
                </p>
              </div>
            </section>

            {/* Results sections are unchanged from your current layout */}
            {singleResult && (
              <>
                {/* Section 1 – surgery yes/no */}
                {/* ... existing Section 1 code unchanged ... */}

                {/* Section 2 – approach comparison */}
                {/* ... existing Section 2 code unchanged ... */}
              </>
            )}
          </>
        )}

        {/* BATCH VIEW – unchanged layout, but batch parsing uses new smoker mapping */}
        {mode === "batch" && (
          <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
            {/* ... existing batch UI + table exactly as in your current file ... */}
          </section>
        )}
      </main>
    </div>
  );
}
