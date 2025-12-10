"use client";

import React, { useState } from "react";
import jsPDF from "jspdf";

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
  severity: Severity | ""; // kept in type, but logic always derives from mJOA
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

// helper: derive severity strictly from mJOA
function deriveSeverity(mJOA: number): Severity {
  if (mJOA >= 15) return "mild";
  if (mJOA >= 12) return "moderate";
  return "severe";
}

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

  // ---- 1) severity derived from mJOA only ----
  const severity: Severity = deriveSeverity(mJOA);

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

// ---- Simple CSV utilities for batch tab ----
function parseCsvToObjects(csv: string): any[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim());
  const rows: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(",");
    if (row.length === 1 && row[0] === "") continue;
    const obj: any = {};
    headers.forEach((h, idx) => {
      obj[h] = (row[idx] ?? "").trim();
    });
    rows.push(obj);
  }
  return rows;
}

function mapCsvRowToInput(row: any): InputState {
  const input: InputState = {
    age: row.age ?? "",
    sex: (row.sex as Sex) || "",
    smoker: row.smoker === "1" ? "1" : "0",
    symptomDurationMonths: row.symptom_duration_months ?? "",
    severity: "",
    baselineMJOA: row.baseline_mJOA ?? "",
    levelsOperated: row.levels_operated ?? "",
    canalRatio: (row.canal_occupying_ratio_cat as CanalRatioCat) || "",
    t2Signal: (row.T2_signal as T2Signal) || "",
    opll: row.OPLL === "1" ? "1" : "0",
    t1Hypo: row.T1_hypointensity === "1" ? "1" : "0",
    gaitImpairment: row.gait_impairment === "1" ? "1" : "0",
    psychDisorder: row.psych_disorder === "1" ? "1" : "0",
    baselineNDI: row.baseline_NDI ?? "",
    sf36PCS: row.baseline_SF36_PCS ?? "",
    sf36MCS: row.baseline_SF36_MCS ?? "",
  };
  return input;
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

  // Batch state
  const [batchCsv, setBatchCsv] = useState("");
  const [batchResults, setBatchResults] = useState<
    { input: InputState; result: SingleResult }[] | null
  >(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);

  // helper to update fields
  function updateField<K extends keyof InputState>(key: K, value: InputState[K]) {
    setInputs((prev) => ({ ...prev, [key]: value }));
  }

  // reset back to blank
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

    const mjoaNum = Number(inputs.baselineMJOA);
    const derivedSeverity = deriveSeverity(mjoaNum);

    setLoading(true);
    try {
      const apiBase = process.env.NEXT_PUBLIC_DCM_API_URL;

      if (apiBase) {
        // ---------- API path ----------
        const payload = {
          age: Number(inputs.age),
          sex: inputs.sex,
          smoker: Number(inputs.smoker),
          symptom_duration_months: Number(inputs.symptomDurationMonths),
          severity: derivedSeverity, // always derived from mJOA
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
        // ---------- local, frozen TS logic ----------
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
          severity: derivedSeverity,
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

  // Batch handler (local TS logic for now)
  async function handleRunBatch() {
    setBatchError(null);
    setBatchResults(null);

    if (!batchCsv.trim()) {
      setBatchError("Paste a CSV with a header row and at least one patient.");
      return;
    }

    const rows = parseCsvToObjects(batchCsv);
    if (!rows.length) {
      setBatchError("Could not parse any rows. Check CSV format and headers.");
      return;
    }

    const results: { input: InputState; result: SingleResult }[] = [];
    setBatchLoading(true);

    try {
      for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx];
        const input = mapCsvRowToInput(row);

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
          const v = input[k];
          const num = Number(v as string);
          if (v === "" || Number.isNaN(num) || num < 0) {
            throw new Error(
              `Row ${idx + 2}: numeric field "${String(
                k
              )}" is missing or invalid (must be non-negative).`
            );
          }
        }

        if (!input.sex || !input.canalRatio || !input.t2Signal) {
          throw new Error(
            `Row ${idx + 2}: sex, canal_occupying_ratio_cat, and T2_signal are required.`
          );
        }

        const mjoaNum = Number(input.baselineMJOA);
        const derivedSeverity = deriveSeverity(mjoaNum);

        const localInputs: Required<InputState> = {
          ...input,
          age: input.age || "0",
          symptomDurationMonths: input.symptomDurationMonths || "0",
          baselineMJOA: input.baselineMJOA || "0",
          levelsOperated: input.levelsOperated || "0",
          baselineNDI: input.baselineNDI || "0",
          sf36PCS: input.sf36PCS || "0",
          sf36MCS: input.sf36MCS || "0",
          sex: input.sex || "M",
          severity: derivedSeverity,
          canalRatio: (input.canalRatio || "50–60%") as CanalRatioCat,
          t2Signal: (input.t2Signal || "none") as T2Signal,
        };

        const res = computeLocalRecommendation(localInputs);
        results.push({ input, result: res });
      }

      setBatchResults(results);
    } catch (e: any) {
      console.error(e);
      setBatchError(e.message ?? "Failed to process batch CSV.");
    } finally {
      setBatchLoading(false);
    }
  }

  // PDF helpers
  function handleExportSinglePdf() {
    if (!result) {
      setError("Run a single-patient recommendation before exporting a PDF.");
      return;
    }

    const doc = new jsPDF();
    const mjoaNum = Number(inputs.baselineMJOA);
    const sev = Number.isNaN(mjoaNum) ? "-" : deriveSeverity(mjoaNum);

    doc.setFontSize(14);
    doc.text("DCM Surgical Decision Support – Single Patient Summary", 10, 15);

    doc.setFontSize(10);
    doc.text(
      `Age: ${inputs.age || "NA"}   Sex: ${inputs.sex || "NA"}   Smoker: ${
        inputs.smoker === "1" ? "Current" : "Non-smoker / former"
      }`,
      10,
      25
    );
    doc.text(
      `mJOA: ${inputs.baselineMJOA || "NA"}   mJOA-based severity: ${sev}`,
      10,
      31
    );
    doc.text(
      `Duration (months): ${inputs.symptomDurationMonths || "NA"}   Planned levels: ${
        inputs.levelsOperated || "NA"
      }`,
      10,
      37
    );
    doc.text(
      `Canal ratio: ${inputs.canalRatio || "NA"}   T2 signal: ${
        inputs.t2Signal || "NA"
      }   OPLL: ${inputs.opll === "1" ? "Yes" : "No"}`,
      10,
      43
    );

    doc.setFontSize(12);
    doc.text(`Recommendation: ${result.recommendationLabel}`, 10, 53);

    doc.setFontSize(10);
    doc.text(
      `Risk without surgery: ${result.riskScore.toFixed(
        0
      )}% – ${result.riskText}`,
      10,
      61
    );
    doc.text(
      `Expected chance of meaningful improvement with surgery: ${result.benefitScore.toFixed(
        0
      )}% – ${result.benefitText}`,
      10,
      69
    );

    const ap = result.approachProbs;
    doc.text(
      `P(MCID) by approach – Anterior: ${Math.round(
        ap.anterior * 100
      )}%, Posterior: ${Math.round(ap.posterior * 100)}%, Circumferential: ${Math.round(
        ap.circumferential * 100
      )}% (best: ${result.bestApproach})`,
      10,
      79
    );

    doc.save("dcm_single_summary.pdf");
  }

  function handleExportBatchPdf() {
    if (!batchResults || batchResults.length === 0) {
      setBatchError("Run a batch recommendation before exporting a PDF.");
      return;
    }

    const doc = new jsPDF();
    doc.setFontSize(14);
    doc.text("DCM Surgical Decision Support – Batch Summary", 10, 15);

    const total = batchResults.length;
    const nSurg = batchResults.filter((r) => r.result.surgeryRecommended).length;
    const nNonSurg = total - nSurg;

    const approachCounts: Record<ApproachKey, number> = {
      anterior: 0,
      posterior: 0,
      circumferential: 0,
    };
    batchResults.forEach((r) => {
      if (r.result.bestApproach !== "none") {
        approachCounts[r.result.bestApproach as ApproachKey]++;
      }
    });

    doc.setFontSize(10);
    doc.text(`Total patients: ${total}`, 10, 25);
    doc.text(`Surgery recommended: ${nSurg}`, 10, 31);
    doc.text(`Non-operative trial reasonable / consider: ${nNonSurg}`, 10, 37);
    doc.text(
      `Best approach – Anterior: ${approachCounts.anterior}, Posterior: ${approachCounts.posterior}, Circumferential: ${approachCounts.circumferential}`,
      10,
      43
    );

    let y = 55;
    doc.setFontSize(9);
    doc.text("Per-patient snapshot (index, age, mJOA, recommendation, best approach)", 10, y);
    y += 6;

    batchResults.forEach((row, idx) => {
      const line = `${idx + 1}) Age ${row.input.age || "NA"}, mJOA ${
        row.input.baselineMJOA || "NA"
      }, rec: ${row.result.recommendationLabel}, best: ${
        row.result.bestApproach
      }`;
      doc.text(line, 10, y);
      y += 5;
      if (y > 280) {
        doc.addPage();
        y = 15;
      }
    });

    doc.save("dcm_batch_summary.pdf");
  }

  // helpers for rendering
  function formatPct(p: number): string {
    return `${Math.round(clamp01(p) * 100)}%`;
  }

  const mjoaNum = Number(inputs.baselineMJOA);
  const autoSeverity = Number.isNaN(mjoaNum) ? null : deriveSeverity(mjoaNum);

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
            <div className="text-xl font-semibold">
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
                <h2 className="mb-4 text-xl font-semibold text-slate-900">
                  1. Patient inputs
                </h2>

                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 text-sm">
                  {/* Age */}
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      Age (years)
                    </label>
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      Sex
                    </label>
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      Smoking status
                    </label>
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      mJOA
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={18}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                      value={inputs.baselineMJOA}
                      onChange={(e) => updateField("baselineMJOA", e.target.value)}
                    />
                  </div>

                  {/* mJOA-derived severity (auto, read-only) */}
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      mJOA-based severity (auto)
                    </label>
                    <div className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
                      {autoSeverity === null && "Enter mJOA to auto-derive severity."}
                      {autoSeverity === "mild" && "Mild (mJOA ≥ 15)"}
                      {autoSeverity === "moderate" && "Moderate (mJOA 12–14)"}
                      {autoSeverity === "severe" && "Severe (mJOA < 12)"}
                    </div>
                  </div>

                  {/* Canal ratio */}
                  <div>
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      Canal occupying ratio
                    </label>
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      T2 cord signal
                    </label>
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      OPLL present
                    </label>
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      T1 hypointensity
                    </label>
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      Gait impairment
                    </label>
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      Psychiatric disorder
                    </label>
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      Baseline NDI
                    </label>
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      SF-36 PCS
                    </label>
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
                    <label className="mb-1 block text-sm font-semibold text-slate-800">
                      SF-36 MCS
                    </label>
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
                  <button
                    type="button"
                    onClick={handleExportSinglePdf}
                    className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Save summary (PDF)
                  </button>
                  {error && <div className="text-sm text-red-600">{error}</div>}
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
                    mJOA-based severity, symptom duration, MRI cord signal, canal
                    compromise, OPLL, gait impairment, and age.
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
                  <h2 className="mb-3 text-xl font-semibold text-slate-900">
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
                      <div className="mb-1 font-medium text-slate-900">
                        Risk without surgery
                      </div>
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
                      <div className="mb-1 font-medium text-slate-900">
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
                    <h2 className="text-xl font-semibold text-slate-900">
                      2. If surgery is offered, which approach?
                    </h2>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-600">
                      Uncertainty:{" "}
                      <span className="capitalize">{result.uncertainty}</span>{" "}
                      <span className="text-[10px] text-slate-500">
                        (low = one clear favorite; high = several similar options)
                      </span>
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

                  {/* P(MCID) by approach bars */}
                  <div className="mt-6">
                    <h3 className="mb-2 text-sm font-semibold text-slate-900">
                      P(MCID) by approach (approximate bands)
                    </h3>
                    <div className="space-y-2 text-xs text-slate-700">
                      {(["anterior", "posterior", "circumferential"] as ApproachKey[]).map(
                        (key) => {
                          const pct = formatPct(result.approachProbs[key]);
                          const label =
                            key === "anterior"
                              ? "Anterior"
                              : key === "posterior"
                              ? "Posterior"
                              : "Circumferential";
                          return (
                            <div key={key} className="flex items-center gap-3">
                              <div className="w-28 font-medium">{label}</div>
                              <div className="flex-1 h-2 rounded-full bg-slate-100">
                                <div
                                  className="h-2 rounded-full bg-emerald-500"
                                  style={{ width: pct }}
                                />
                              </div>
                              <div className="w-10 text-right">{pct}</div>
                            </div>
                          );
                        }
                      )}
                    </div>
                  </div>

                  <div className="mt-4 text-xs text-slate-500">
                    Patterns are derived from guideline-informed logic and synthetic
                    outcome data and are intended to support, not replace, surgeon
                    judgment.
                  </div>
                </section>
              </div>
            )}

            {/* Bottom info card */}
            <section className="rounded-2xl bg-white p-5 text-xs text-slate-600 shadow-sm">
              <div className="mb-1 text-sm font-semibold text-slate-900">
                Hybrid guideline + ML engine
              </div>
              <p>
                This prototype blends AO Spine / WFNS guideline concepts (myelopathy
                severity, cord signal, canal compromise, OPLL, gait) with patterns learned
                from large synthetic DCM outcome cohorts. It is intended to structure
                discussions and document reasoning, not to mandate treatment.
              </p>
            </section>
          </>
        ) : (
          // --------- Batch tab ----------
          <section className="rounded-2xl bg-white p-6 text-sm shadow-sm">
            <h2 className="mb-3 text-xl font-semibold text-slate-900">Batch (CSV)</h2>
            <p className="mb-3 text-slate-700">
              Paste a CSV with one row per patient using this header (order can match
              your export):
            </p>
            <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] font-mono text-slate-700">
              age,sex,smoker,symptom_duration_months,severity,baseline_mJOA,levels_operated,canal_occupying_ratio_cat,T2_signal,OPLL,T1_hypointensity,gait_impairment,psych_disorder,baseline_NDI,baseline_SF36_PCS,baseline_SF36_MCS
            </p>
            <textarea
              rows={10}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-800"
              placeholder="age,sex,smoker,symptom_duration_months,severity,baseline_mJOA,levels_operated,canal_occupying_ratio_cat,T2_signal,OPLL,T1_hypointensity,gait_impairment,psych_disorder,baseline_NDI,baseline_SF36_PCS,baseline_SF36_MCS
65,M,0,12,moderate,13,3,50–60%,multilevel,0,0,1,0,40,40,45"
              value={batchCsv}
              onChange={(e) => setBatchCsv(e.target.value)}
            />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleRunBatch}
                disabled={batchLoading}
                className="rounded-full bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
              >
                {batchLoading ? "Running..." : "Run batch recommendations"}
              </button>
              <button
                type="button"
                onClick={handleExportBatchPdf}
                className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Save batch summary (PDF)
              </button>
              {batchError && <div className="text-sm text-red-600">{batchError}</div>}
            </div>

            {batchResults && (
              <>
                <div className="mt-6 text-sm text-slate-800">
                  <div className="font-semibold">
                    Summary for {batchResults.length} patients
                  </div>
                  <div className="mt-1 text-xs text-slate-600">
                    Surgery recommended in{" "}
                    {
                      batchResults.filter((r) => r.result.surgeryRecommended)
                        .length
                    }{" "}
                    patients; non-operative trial or consider surgery in the remainder.
                  </div>
                </div>

                <div className="mt-4 overflow-x-auto">
                  <table className="min-w-full border-t border-slate-200 text-xs">
                    <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-2 py-1 text-left">#</th>
                        <th className="px-2 py-1 text-left">Age</th>
                        <th className="px-2 py-1 text-left">Sex</th>
                        <th className="px-2 py-1 text-left">mJOA</th>
                        <th className="px-2 py-1 text-left">Severity</th>
                        <th className="px-2 py-1 text-left">T2</th>
                        <th className="px-2 py-1 text-left">Canal</th>
                        <th className="px-2 py-1 text-left">Rec</th>
                        <th className="px-2 py-1 text-left">Best approach</th>
                        <th className="px-2 py-1 text-left">Uncertainty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchResults.map(({ input, result }, idx) => {
                        const m = Number(input.baselineMJOA);
                        const sev = Number.isNaN(m) ? "-" : deriveSeverity(m);
                        return (
                          <tr
                            key={idx}
                            className={idx % 2 === 0 ? "bg-white" : "bg-slate-50/60"}
                          >
                            <td className="px-2 py-1">{idx + 1}</td>
                            <td className="px-2 py-1">{input.age}</td>
                            <td className="px-2 py-1">{input.sex}</td>
                            <td className="px-2 py-1">{input.baselineMJOA}</td>
                            <td className="px-2 py-1 capitalize">{sev}</td>
                            <td className="px-2 py-1">{input.t2Signal}</td>
                            <td className="px-2 py-1">{input.canalRatio}</td>
                            <td className="px-2 py-1">{result.recommendationLabel}</td>
                            <td className="px-2 py-1 capitalize">
                              {result.bestApproach}
                            </td>
                            <td className="px-2 py-1 capitalize">
                              {result.uncertainty}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
