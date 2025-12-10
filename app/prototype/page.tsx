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
  severity: Severity | ""; // logic always derives from mJOA
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

// ---- Default starting state ----
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

function deriveSeverity(mJOA: number): Severity {
  if (mJOA >= 15) return "mild";
  if (mJOA >= 12) return "moderate";
  return "severe";
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

// -----------------
// Local rule engine
// -----------------
function computeLocalRecommendation(input: Required<InputState>): SingleResult {
  const age = Number(input.age);
  const dur = Number(input.symptomDurationMonths);
  const mJOA = Number(input.baselineMJOA);
  const levels = Number(input.levelsOperated);
  const ndi = Number(input.baselineNDI);

  const severity: Severity = deriveSeverity(mJOA);

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

  // surgery recommendation
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
  }

  // approach probabilities
  let approach: ApproachProbs = {
    anterior: 0.33,
    posterior: 0.34,
    circumferential: 0.33,
  };

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

  function updateField<K extends keyof InputState>(key: K, value: InputState[K]) {
    setInputs((prev) => ({ ...prev, [key]: value }));
  }

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

  function handlePrintPage() {
    if (typeof window !== "undefined") {
      window.print();
    }
  }

  async function handleRunSingle() {
    setError(null);

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
        // API path
        const payload = {
          age: Number(inputs.age),
          sex: inputs.sex,
          smoker: Number(inputs.smoker),
          symptom_duration_months: Number(inputs.symptomDurationMonths),
          severity: derivedSeverity,
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
        // Local TS logic
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

  async function handleRunBatch() {
    setBatchError(null);
    setBatchResults(null);

    if (!batchCsv.trim()) {
      setBatchError("Paste a CSV or upload a file with at least one patient.");
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

  function handleBatchFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setBatchCsv(String(reader.result ?? ""));
    };
    reader.readAsText(file);
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
              {/* ... single-patient section unchanged ... */}
              {/* (kept as in your original file) */}
            </div>

            {/* ... results + info card sections unchanged ... */}
          </>
        ) : (
          // --------- Batch tab ----------
          <section className="rounded-2xl bg-white p-6 text-sm shadow-sm">
            <h2 className="mb-3 text-xl font-semibold text-slate-900">Batch (CSV)</h2>
            <p className="mb-3 text-slate-700">
              Upload a CSV file or paste data with one row per patient using this header
              (order can match your export):
            </p>
            {/* ✅ UPDATED: allow wrapping of long header line */}
            <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] font-mono text-slate-700 whitespace-normal break-words">
              age,sex,smoker,symptom_duration_months,severity,baseline_mJOA,levels_operated,canal_occupying_ratio_cat,T2_signal,OPLL,T1_hypointensity,gait_impairment,psych_disorder,baseline_NDI,baseline_SF36_PCS,baseline_SF36_MCS
            </p>

            {/* File upload */}
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
              <label className="text-slate-700 font-semibold">
                Upload CSV file:
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleBatchFileChange}
                  className="ml-3 text-xs"
                />
              </label>
              <span className="text-slate-500">
                Uploaded content will appear in the box below so you can review or edit
                if needed.
              </span>
            </div>

            <textarea
              rows={10}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-800"
              placeholder="age,sex,smoker,symptom_duration_months,severity,baseline_mJOA,levels_operated,canal_occupying_ratio_cat,T2_signal,OPLL,T1_hypointensity,gait_impairment,psych_disorder,baseline_NDI,baseline_SF36_PCS,baseline_SF36_MCS
65,M,0,12,moderate,13,3,50–60%,multilevel,0,0,1,0,40,40,45"
              value={batchCsv}
              onChange={(e) => setBatchCsv(e.target.value)}
            />
            {/* ... rest of batch section unchanged ... */}
          </section>
        )}
      </main>
    </div>
  );
}
