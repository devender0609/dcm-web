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
  baselineMJOA: string;
  levelsOperated: string;
  severityOverride: Severity | ""; // allow override in batch if needed
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

type ResultState = {
  riskScore: number;
  riskText: string;
  benefitScore: number;
  benefitText: string;
  recommendationLabel: string;
  bestApproach: ApproachKey;
  approachProbs: Record<ApproachKey, number>;
  uncertainty: "low" | "moderate" | "high";
};

// batch result row
type BatchResultRow = {
  index: number;
  age: number | null;
  baselineMJOA: number | null;
  severity: Severity | "";
  riskScore: number | null;
  benefitScore: number | null;
  recommendationLabel: string;
  bestApproach: ApproachKey | "";
  error?: string;
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ---- Helpers to compute severity and scoring ----
function deriveSeverity(mjoa: number | null): Severity | "" {
  if (mjoa == null || Number.isNaN(mjoa)) return "";
  if (mjoa >= 15) return "mild";
  if (mjoa >= 12) return "moderate";
  return "severe";
}

function computeModel(
  input: InputState
): ResultState | { error: string } {
  // Basic validation – keep same as before
  const ageNum = parseFloat(input.age);
  const symDur = parseFloat(input.symptomDurationMonths);
  const mjoaNum = parseFloat(input.baselineMJOA);
  const levels = parseFloat(input.levelsOperated);
  const ndi = parseFloat(input.baselineNDI);
  const pcs = parseFloat(input.sf36PCS);
  const mcs = parseFloat(input.sf36MCS);

  if (
    Number.isNaN(ageNum) ||
    ageNum < 18 ||
    ageNum > 95 ||
    Number.isNaN(symDur) ||
    symDur < 0 ||
    symDur > 240 ||
    Number.isNaN(mjoaNum) ||
    mjoaNum < 0 ||
    mjoaNum > 18 ||
    Number.isNaN(levels) ||
    levels < 1 ||
    levels > 8 ||
    Number.isNaN(ndi) ||
    ndi < 0 ||
    ndi > 100 ||
    Number.isNaN(pcs) ||
    pcs < 10 ||
    pcs > 80 ||
    Number.isNaN(mcs) ||
    mcs < 10 ||
    mcs > 80 ||
    !input.sex ||
    !input.canalRatio ||
    !input.t2Signal
  ) {
    return { error: "Please complete all fields within allowed ranges." };
  }

  const severity: Severity =
    input.severityOverride || deriveSeverity(mjoaNum) || "moderate";

  // ---- Risk model (heuristic / prototype) ----
  let riskScore = 0;

  // Base by severity
  if (severity === "severe") riskScore += 55;
  else if (severity === "moderate") riskScore += 35;
  else riskScore += 20;

  // Duration
  if (symDur >= 24 && symDur < 60) riskScore += 5;
  else if (symDur >= 60) riskScore += 10;

  // Canal compromise
  if (input.canalRatio === "50–60%") riskScore += 5;
  else if (input.canalRatio === ">60%") riskScore += 10;

  // Cord signal change
  if (input.t2Signal === "focal") riskScore += 5;
  else if (input.t2Signal === "multilevel") riskScore += 10;

  if (input.t1Hypo === "1") riskScore += 5;
  if (input.opll === "1") riskScore += 5;
  if (input.gaitImpairment === "1") riskScore += 5;

  // Psych disorder slightly increases risk of poor spontaneous recovery
  if (input.psychDisorder === "1") riskScore += 3;

  // Age
  if (ageNum >= 70) riskScore += 5;
  else if (ageNum <= 40) riskScore -= 3;

  // Clamp between 5 and 100
  riskScore = clampNumber(riskScore, 5, 100);

  // ---- Benefit model ----
  let benefitScore = 0;

  if (severity === "severe") benefitScore += 45;
  else if (severity === "moderate") benefitScore += 35;
  else benefitScore += 20;

  // Imaging factors that suggest more reversible compression
  if (input.canalRatio === "50–60%") benefitScore += 5;
  else if (input.canalRatio === ">60%") benefitScore += 7;

  if (input.t2Signal === "focal") benefitScore += 5;
  else if (input.t2Signal === "multilevel") benefitScore += 3;

  if (input.opll === "1") benefitScore -= 3;

  // Gait impairment often has room to improve if decompressed
  if (input.gaitImpairment === "1") benefitScore += 5;

  // Age and baseline function
  if (ageNum <= 60) benefitScore += 5;
  if (pcs >= 30 && pcs <= 50) benefitScore += 5;
  if (ndi >= 20 && ndi <= 60) benefitScore += 5;

  // Very high symptom duration may reduce improvement
  if (symDur >= 120) benefitScore -= 5;

  benefitScore = clampNumber(benefitScore, 5, 100);

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
      (riskScore >= 40 && benefitScore >= 40))
  ) {
    surgeryRecommended = true;
    recommendationLabel = "Consider surgery";
  } else {
    recommendationLabel = "Non-operative trial reasonable";
  }

  // ---- Approach distribution ----
  const levelsNum = levels;
  const hasOPLL = input.opll === "1";
  const multilevelSignal = input.t2Signal === "multilevel";

  let anterior = 0.33;
  let posterior = 0.5;
  let circumferential = 0.17;

  if (levelsNum <= 2 && !hasOPLL && !multilevelSignal) {
    anterior = 0.55;
    posterior = 0.35;
    circumferential = 0.1;
  } else if (levelsNum >= 4 || multilevelSignal || hasOPLL) {
    posterior = 0.55;
    anterior = 0.2;
    circumferential = 0.25;
  } else if (levelsNum === 3) {
    anterior = 0.35;
    posterior = 0.45;
    circumferential = 0.2;
  }

  // Normalize
  const total = anterior + posterior + circumferential;
  anterior /= total;
  posterior /= total;
  circumferential /= total;

  const approachProbs = { anterior, posterior, circumferential };

  let bestApproach: ApproachKey = "posterior";
  let bestProb = approachProbs[bestApproach];

  (["anterior", "posterior", "circumferential"] as ApproachKey[]).forEach((k) => {
    if (approachProbs[k] > bestProb) {
      bestProb = approachProbs[k];
      bestApproach = k;
    }
  });

  // Uncertainty: how close are we?
  const sorted = Object.values(approachProbs).sort((a, b) => b - a);
  const diff = sorted[0] - sorted[1];
  let uncertainty: "low" | "moderate" | "high" = "low";
  if (diff < 0.1) uncertainty = "high";
  else if (diff < 0.2) uncertainty = "moderate";

  return {
    riskScore,
    riskText,
    benefitScore,
    benefitText,
    recommendationLabel,
    bestApproach,
    approachProbs,
    uncertainty,
  };
}

// ---------- React page component ----------
export default function Page() {
  const [activeTab, setActiveTab] = useState<"single" | "batch">("single");
  const [inputs, setInputs] = useState<InputState>({
    age: "",
    sex: "",
    smoker: "0",
    symptomDurationMonths: "",
    baselineMJOA: "",
    levelsOperated: "",
    severityOverride: "",
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

  const [result, setResult] = useState<ResultState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Batch state
  const [batchCsv, setBatchCsv] = useState("");
  const [batchResults, setBatchResults] = useState<BatchResultRow[] | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);

  const numericRanges =
    "Numeric ranges: Age 18–95; mJOA 0–18; planned levels 1–8; NDI 0–100; SF-36 PCS/MCS 10–80; symptom duration 0–240 months.";

  function updateField<K extends keyof InputState>(field: K, value: InputState[K]) {
    setInputs((prev) => ({ ...prev, [field]: value }));
    setResult(null);
    setError(null);
  }

  const autoSeverity = deriveSeverity(
    inputs.baselineMJOA ? parseFloat(inputs.baselineMJOA) : null
  );

  function handleRunSingle() {
    const res = computeModel(inputs);
    if ("error" in res) {
      setError(res.error);
      setResult(null);
    } else {
      setResult(res);
      setError(null);
    }
  }

  function handleResetSingle() {
    setInputs({
      age: "",
      sex: "",
      smoker: "0",
      symptomDurationMonths: "",
      baselineMJOA: "",
      levelsOperated: "",
      severityOverride: "",
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

  function handlePrintSingle() {
    if (!result) return;

    const doc = new jsPDF();

    doc.setFontSize(16);
    doc.text("Degenerative Cervical Myelopathy Decision-Support Summary", 10, 15);

    doc.setFontSize(12);
    doc.text("Single-patient output", 10, 23);

    doc.setFontSize(10);
    doc.text(
      `Inputs – Age: ${inputs.age}, Sex: ${inputs.sex || "N/A"}, Symptom duration: ${
        inputs.symptomDurationMonths
      } months, mJOA: ${inputs.baselineMJOA}, Planned levels: ${
        inputs.levelsOperated
      }, Canal occupying ratio: ${inputs.canalRatio || "N/A"}, T2 signal: ${
        inputs.t2Signal || "N/A"
      }, OPLL: ${inputs.opll === "1" ? "Yes" : "No"}, T1 hypointensity: ${
        inputs.t1Hypo === "1" ? "Yes" : "No"
      }, Gait impairment: ${
        inputs.gaitImpairment === "1" ? "Yes" : "No"
      }, Psychiatric disorder: ${
        inputs.psychDisorder === "1" ? "Yes" : "No"
      }, NDI: ${inputs.baselineNDI}, SF-36 PCS: ${inputs.sf36PCS}, SF-36 MCS: ${
        inputs.sf36MCS
      }`,
      10,
      33,
      { maxWidth: 190 }
    );

    doc.setFontSize(12);
    doc.text("Modeled risk and benefit", 10, 45);

    doc.setFontSize(10);
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
      )}%`,
      10,
      79
    );
    doc.text(`Best approach: ${result.bestApproach}`, 10, 87);
    doc.text(`Uncertainty label: ${result.uncertainty}`, 10, 95);

    doc.setFontSize(9);
    doc.text(
      "Important caveats: This prototype is based on patterns in published cohorts and synthetic data.",
      10,
      110,
      { maxWidth: 190 }
    );
    doc.text(
      "It does not account for all factors (frailty, alignment, prior surgery, specific comorbidities) and should not be used as a stand-alone gatekeeper.",
      10,
      116,
      { maxWidth: 190 }
    );
    doc.text(
      "Final decisions should integrate clinical examination, full imaging review, and multidisciplinary input where appropriate.",
      10,
      122,
      { maxWidth: 190 }
    );

    doc.save("dcm_single_patient_summary.pdf");
  }

  function parseBatchCsv(text: string): {
    rows: InputState[];
    errors: string | null;
  } {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) {
      return { rows: [], errors: "No data found." };
    }

    const headerLine = lines[0];
    const headerExpected =
      "age,sex,smoker,symptom_duration_months,severity,baseline_mJOA,levels_operated,canal_occupying_ratio_cat,T2_signal,OPLL,T1_hypointensity,gait_impairment,psych_disorder,baseline_NDI,baseline_SF36_PCS,baseline_SF36_MCS";

    const headerNorm = headerLine.replace(/\s+/g, "").toLowerCase();
    const expectedNorm = headerExpected.replace(/\s+/g, "").toLowerCase();

    if (!headerNorm.startsWith(expectedNorm)) {
      return {
        rows: [],
        errors:
          "Header mismatch. Expected: " +
          headerExpected +
          ". Please paste data with this exact header.",
      };
    }

    const dataLines = lines.slice(1);
    const rows: InputState[] = [];

    dataLines.forEach((line, index) => {
      const cols = line.split(",").map((c) => c.trim());

      if (cols.length < 16) {
        return;
      }

      const [
        age,
        sex,
        smoker,
        symptomDurationMonths,
        severityStr,
        baselineMJOA,
        levelsOperated,
        canalRatioRaw,
        t2SignalRaw,
        opll,
        t1Hypo,
        gaitImpairment,
        psychDisorder,
        baselineNDI,
        sf36PCS,
        sf36MCS,
      ] = cols;

      const canalNormalized = canalRatioRaw.replace(" ", "");
      let canalRatio: CanalRatioCat | "" = "";
      if (canalNormalized === "<50%" || canalNormalized === "<50%") {
        canalRatio = "<50%";
      } else if (
        canalNormalized === "50–60%" ||
        canalNormalized === "50-60%" ||
        canalNormalized === "50–60" ||
        canalNormalized === "50-60"
      ) {
        canalRatio = "50–60%";
      } else if (
        canalNormalized === ">60%" ||
        canalNormalized === ">60% " ||
        canalNormalized === ">60"
      ) {
        canalRatio = ">60%";
      }

      let t2Signal: T2Signal | "" = "";
      const t2Lower = t2SignalRaw.toLowerCase();
      if (t2Lower.startsWith("none")) t2Signal = "none";
      else if (t2Lower.startsWith("focal")) t2Signal = "focal";
      else if (t2Lower.startsWith("multi")) t2Signal = "multilevel";

      let severityOverride: Severity | "" = "";
      const sevLower = severityStr.toLowerCase();
      if (sevLower.startsWith("mild")) severityOverride = "mild";
      else if (sevLower.startsWith("moderate")) severityOverride = "moderate";
      else if (sevLower.startsWith("severe")) severityOverride = "severe";

      rows.push({
        age,
        sex: sex === "M" || sex === "F" ? sex : "",
        smoker: smoker === "1" ? "1" : "0",
        symptomDurationMonths,
        baselineMJOA,
        levelsOperated,
        severityOverride,
        canalRatio,
        t2Signal,
        opll: opll === "1" ? "1" : "0",
        t1Hypo: t1Hypo === "1" ? "1" : "0",
        gaitImpairment: gaitImpairment === "1" ? "1" : "0",
        psychDisorder: psychDisorder === "1" ? "1" : "0",
        baselineNDI,
        sf36PCS,
        sf36MCS,
      });
    });

    if (rows.length === 0) {
      return { rows: [], errors: "No valid data rows found after the header." };
    }

    return { rows, errors: null };
  }

  function handleRunBatch() {
    setBatchError(null);
    setBatchResults(null);
    setBatchLoading(true);

    try {
      const { rows, errors } = parseBatchCsv(batchCsv);
      if (errors) {
        setBatchError(errors);
        setBatchLoading(false);
        return;
      }

      const results: BatchResultRow[] = rows.map((row, index) => {
        const ageNum = parseFloat(row.age);
        const mjoaNum = parseFloat(row.baselineMJOA);
        const severity = row.severityOverride || deriveSeverity(mjoaNum);

        if (
          Number.isNaN(ageNum) ||
          ageNum < 18 ||
          ageNum > 95 ||
          Number.isNaN(mjoaNum) ||
          mjoaNum < 0 ||
          mjoaNum > 18
        ) {
          return {
            index: index + 1,
            age: Number.isNaN(ageNum) ? null : ageNum,
            baselineMJOA: Number.isNaN(mjoaNum) ? null : mjoaNum,
            severity: severity || "",
            riskScore: null,
            benefitScore: null,
            recommendationLabel: "Invalid input",
            bestApproach: "",
            error: "Age or mJOA out of range.",
          };
        }

        const res = computeModel(row);

        if ("error" in res) {
          return {
            index: index + 1,
            age: ageNum,
            baselineMJOA: mjoaNum,
            severity: severity || "",
            riskScore: null,
            benefitScore: null,
            recommendationLabel: "Invalid row",
            bestApproach: "",
            error: res.error,
          };
        }

        return {
          index: index + 1,
          age: ageNum,
          baselineMJOA: mjoaNum,
          severity: severity || "",
          riskScore: res.riskScore,
          benefitScore: res.benefitScore,
          recommendationLabel: res.recommendationLabel,
          bestApproach: res.bestApproach,
        };
      });

      setBatchResults(results);
    } catch (e: any) {
      setBatchError("Unable to parse CSV. Please check formatting.");
    } finally {
      setBatchLoading(false);
    }
  }

  function handlePrintBatchSummary() {
    if (!batchResults || batchResults.length === 0) return;

    const doc = new jsPDF({ orientation: "landscape" });

    doc.setFontSize(14);
    doc.text("Degenerative Cervical Myelopathy – Batch Summary", 10, 15);

    doc.setFontSize(10);
    doc.text(
      "This summary lists modeled risk, benefit, and recommended approach for each row.",
      10,
      22
    );

    const headers = [
      "Row",
      "Age",
      "mJOA",
      "Severity",
      "Risk w/o surgery",
      "Benefit w/ surgery",
      "Recommendation",
      "Best approach",
    ];

    const colWidths = [10, 12, 12, 20, 30, 30, 55, 25];
    const startX = 10;
    let y = 30;

    doc.setFontSize(9);
    let x = startX;
    headers.forEach((h, idx) => {
      doc.text(h, x, y);
      x += colWidths[idx];
    });

    y += 6;
    doc.setFontSize(8);

    batchResults.forEach((row) => {
      if (y > 190) {
        doc.addPage();
        y = 20;
      }
      let xRow = startX;
      const cells = [
        row.index.toString(),
        row.age != null ? row.age.toString() : "-",
        row.baselineMJOA != null ? row.baselineMJOA.toString() : "-",
        row.severity ? row.severity : "-",
        row.riskScore != null ? `${row.riskScore.toFixed(0)}%` : "-",
        row.benefitScore != null ? `${row.benefitScore.toFixed(0)}%` : "-",
        row.recommendationLabel,
        row.bestApproach || "-",
      ];

      cells.forEach((c, idx) => {
        doc.text(c, xRow, y, { maxWidth: colWidths[idx] - 2 });
        xRow += colWidths[idx];
      });

      y += 5;
    });

    doc.save("dcm_batch_summary.pdf");
  }

  function handlePrintBatchView() {
    if (!batchResults || batchResults.length === 0) return;

    const doc = new jsPDF({ orientation: "portrait" });

    doc.setFontSize(14);
    doc.text("Degenerative Cervical Myelopathy – Batch Recommendations", 10, 15);

    doc.setFontSize(10);
    doc.text(
      "Per-patient modeled risk, benefit, and recommended approach.",
      10,
      22
    );

    const headers = [
      "Row",
      "Age",
      "mJOA",
      "Severity",
      "Risk w/o surgery",
      "Benefit w/ surgery",
      "Recommendation",
      "Best approach",
    ];
    const colWidths = [10, 12, 12, 20, 30, 30, 55, 25];

    const startX = 10;
    let y = 30;

    doc.setFontSize(9);
    let x = startX;
    headers.forEach((h, idx) => {
      doc.text(h, x, y);
      x += colWidths[idx];
    });

    y += 6;
    doc.setFontSize(8);

    batchResults.forEach((row) => {
      if (y > 270) {
        doc.addPage();
        y = 20;
      }
      let xRow = startX;
      const cells = [
        row.index.toString(),
        row.age != null ? row.age.toString() : "-",
        row.baselineMJOA != null ? row.baselineMJOA.toString() : "-",
        row.severity ? row.severity : "-",
        row.riskScore != null ? `${row.riskScore.toFixed(0)}%` : "-",
        row.benefitScore != null ? `${row.benefitScore.toFixed(0)}%` : "-",
        row.recommendationLabel,
        row.bestApproach || "-",
      ];

      cells.forEach((c, idx) => {
        doc.text(c, xRow, y, { maxWidth: colWidths[idx] - 2 });
        xRow += colWidths[idx];
      });

      y += 5;
    });

    doc.save("dcm_batch_detailed_view.pdf");
  }

  function handlePrint() {
    window.print();
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-slate-900">Ascension</span>
              <span className="text-lg font-semibold text-slate-900">Seton</span>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold text-slate-900">
              Ascension Texas Spine and Scoliosis
            </p>
            <p className="text-[11px] text-slate-500">
              Degenerative Cervical Myelopathy Decision-Support Tool
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex gap-2 rounded-full bg-slate-100 p-1 text-xs">
            <button
              type="button"
              onClick={() => setActiveTab("single")}
              className={`rounded-full px-3 py-1 ${
                activeTab === "single"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600"
              }`}
            >
              Single patient
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("batch")}
              className={`rounded-full px-3 py-1 ${
                activeTab === "batch"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600"
              }`}
            >
              Batch (CSV)
            </button>
          </div>
          <p className="hidden text-[11px] text-slate-500 md:block">{numericRanges}</p>
        </div>

        <p className="mb-3 text-[11px] text-slate-500 md:hidden">{numericRanges}</p>

        {activeTab === "single" ? (
          <>
            <div className="mb-6 grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              {/* Left column – patient inputs */}
              <section className="rounded-2xl bg-white p-6 shadow-sm">
                <h2 className="mb-4 text-lg font-semibold text-slate-900">
                  Patient profile & imaging features
                </h2>

                <div className="grid gap-4 md:grid-cols-2">
                  {/* Age */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Age (years)
                    </label>
                    <input
                      type="number"
                      min={18}
                      max={95}
                      value={inputs.age}
                      onChange={(e) => updateField("age", e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    />
                  </div>

                  {/* Sex */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Sex
                    </label>
                    <select
                      value={inputs.sex}
                      onChange={(e) =>
                        updateField("sex", e.target.value === "M" || e.target.value === "F" ? e.target.value : "")
                      }
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    >
                      <option value="">Select</option>
                      <option value="M">Male</option>
                      <option value="F">Female</option>
                    </select>
                  </div>

                  {/* Smoking status */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Smoking status
                    </label>
                    <select
                      value={inputs.smoker}
                      onChange={(e) => updateField("smoker", e.target.value as "0" | "1")}
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    >
                      <option value="0">Non-smoker / former</option>
                      <option value="1">Current smoker</option>
                    </select>
                  </div>

                  {/* Symptom duration */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Symptom duration (months)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={240}
                      value={inputs.symptomDurationMonths}
                      onChange={(e) => updateField("symptomDurationMonths", e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    />
                  </div>

                  {/* Baseline mJOA */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Baseline mJOA (0–18)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={18}
                      value={inputs.baselineMJOA}
                      onChange={(e) => updateField("baselineMJOA", e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    />
                    {autoSeverity && (
                      <p className="mt-1 text-[11px] text-slate-500">
                        mJOA-based severity (auto):{" "}
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-[1px] text-[10px] font-semibold ${
                            autoSeverity === "mild"
                              ? "bg-emerald-100 text-emerald-700"
                              : autoSeverity === "moderate"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-rose-100 text-rose-700"
                          }`}
                        >
                          {autoSeverity === "mild"
                            ? "Mild"
                            : autoSeverity === "moderate"
                            ? "Moderate"
                            : "Severe"}
                        </span>
                      </p>
                    )}
                  </div>

                  {/* Planned operated levels */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Planned operated levels
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={inputs.levelsOperated}
                      onChange={(e) => updateField("levelsOperated", e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    />
                  </div>

                  {/* Canal occupying ratio */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Maximum canal occupying ratio
                    </label>
                    <select
                      value={inputs.canalRatio}
                      onChange={(e) =>
                        updateField(
                          "canalRatio",
                          e.target.value as "<50%" | "50–60%" | ">60%" | ""
                        )
                      }
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    >
                      <option value="">Select</option>
                      <option value="<50%">&lt;50%</option>
                      <option value="50–60%">50–60%</option>
                      <option value=">60%">&gt;60%</option>
                    </select>
                  </div>

                  {/* T2 signal */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      T2 cord signal change
                    </label>
                    <select
                      value={inputs.t2Signal}
                      onChange={(e) =>
                        updateField(
                          "t2Signal",
                          e.target.value as "none" | "focal" | "multilevel" | ""
                        )
                      }
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    >
                      <option value="">Select</option>
                      <option value="none">None</option>
                      <option value="focal">Focal</option>
                      <option value="multilevel">Multilevel</option>
                    </select>
                  </div>

                  {/* OPLL */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      OPLL present
                    </label>
                    <select
                      value={inputs.opll}
                      onChange={(e) => updateField("opll", e.target.value as "0" | "1")}
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    >
                      <option value="0">No</option>
                      <option value="1">Yes</option>
                    </select>
                  </div>

                  {/* T1 hypointensity */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      T1 cord hypointensity
                    </label>
                    <select
                      value={inputs.t1Hypo}
                      onChange={(e) => updateField("t1Hypo", e.target.value as "0" | "1")}
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    >
                      <option value="0">No</option>
                      <option value="1">Yes</option>
                    </select>
                  </div>

                  {/* Gait impairment */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Clinically evident gait impairment
                    </label>
                    <select
                      value={inputs.gaitImpairment}
                      onChange={(e) =>
                        updateField("gaitImpairment", e.target.value as "0" | "1")
                      }
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    >
                      <option value="0">No</option>
                      <option value="1">Yes</option>
                    </select>
                  </div>

                  {/* Psych disorder */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Significant mood / anxiety disorder
                    </label>
                    <select
                      value={inputs.psychDisorder}
                      onChange={(e) =>
                        updateField("psychDisorder", e.target.value as "0" | "1")
                      }
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    >
                      <option value="0">No</option>
                      <option value="1">Yes</option>
                    </select>
                  </div>

                  {/* Baseline NDI */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Baseline NDI (0–100)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={inputs.baselineNDI}
                      onChange={(e) => updateField("baselineNDI", e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    />
                  </div>

                  {/* SF-36 PCS */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Baseline SF-36 PCS (10–80)
                    </label>
                    <input
                      type="number"
                      min={10}
                      max={80}
                      value={inputs.sf36PCS}
                      onChange={(e) => updateField("sf36PCS", e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    />
                  </div>

                  {/* SF-36 MCS */}
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Baseline SF-36 MCS (10–80)
                    </label>
                    <input
                      type="number"
                      min={10}
                      max={80}
                      value={inputs.sf36MCS}
                      onChange={(e) => updateField("sf36MCS", e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                    />
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleRunSingle}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
                  >
                    Run recommendation
                  </button>
                  <button
                    type="button"
                    onClick={handleResetSingle}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={handlePrintSingle}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    Save single-patient PDF
                  </button>
                  <button
                    type="button"
                    onClick={handlePrint}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    Print page
                  </button>
                </div>

                {error && (
                  <p className="mt-3 text-sm text-rose-600">
                    <span className="font-semibold">Input error: </span>
                    {error}
                  </p>
                )}
              </section>

              {/* Right column – explanatory panel */}
              <section className="rounded-2xl bg-slate-900 p-6 text-slate-50 shadow-sm">
                <h2 className="mb-1 text-base font-semibold text-emerald-200">
                  How to interpret this tool
                </h2>
                <p className="mb-3 text-[11px] text-slate-200">
                  This prototype integrates mJOA-based myelopathy severity with MRI features
                  (cord compression, T2/T1 signal change, OPLL), gait impairment, and
                  baseline patient-reported scores (NDI, SF-36 PCS/MCS). It is intended to
                  structure discussion—not replace clinical judgment or shared decision
                  making.
                </p>
                <h3 className="mt-4 mb-1 text-[11px] font-semibold text-emerald-200">
                  Risk without surgery
                </h3>
                <p className="mb-2 text-[11px] text-slate-200">
                  The risk estimate summarizes the likelihood of neurological worsening
                  or failure to improve meaningfully if decompression is not performed,
                  based on observed combinations of severity, symptom duration, and high-risk
                  MRI features in published cohorts.
                </p>
                <h3 className="mt-3 mb-1 text-[11px] font-semibold text-emerald-200">
                  Expected chance of meaningful improvement with surgery
                </h3>
                <p className="mb-2 text-[11px] text-slate-200">
                  The improvement estimate reflects the modeled probability of achieving a
                  clinically important gain in mJOA and functional status. It is generally
                  higher in patients with at least moderate myelopathy, imaging evidence of
                  cord compression, and sufficient neurologic reserve.
                </p>
                <h3 className="mt-3 mb-1 text-[11px] font-semibold text-emerald-200">
                  If surgery is offered, which approach?
                </h3>
                <p className="mb-2 text-[11px] text-slate-200">
                  The model distributes probability across anterior, posterior, and
                  circumferential decompression/fusion strategies based on the number of
                  levels, canal occupying ratio, T2 signal pattern, and presence of OPLL.
                  The highlighted “best” approach simply has the highest estimated
                  probability of achieving meaningful improvement while maintaining an
                  acceptable risk profile.
                </p>
                <p className="mb-2 text-[11px] text-slate-200">
                  <span className="font-semibold text-emerald-200">Uncertainty label:</span>{" "}
                  when one approach is clearly favored (e.g., posterior-only for extensive
                  multilevel disease), the label will be “low uncertainty.” If anterior and
                  posterior strategies are close in predicted benefit, the label may read
                  “moderate” or “high uncertainty,” signaling that surgeon experience,
                  alignment goals, and patient preferences should drive the final choice.
                </p>
                <h3 className="mt-4 mb-1 text-[11px] font-semibold text-emerald-200">
                  Important caveats
                </h3>
                <ul className="list-disc space-y-1 pl-4 text-[11px] text-slate-200">
                  <li>
                    The tool does not account for all factors (frailty, alignment, prior
                    surgery, specific comorbidities).
                  </li>
                  <li>
                    It should not be used as a stand-alone gatekeeper for offering or denying
                    surgery.
                  </li>
                  <li>
                    Final decisions should integrate clinical examination, full imaging
                    review, and multidisciplinary input where appropriate.
                  </li>
                </ul>
              </section>
            </div>

            {/* Results card */}
            <section className="rounded-2xl bg-white p-6 shadow-sm">
              <h2 className="mb-3 text-lg font-semibold text-slate-900">
                Model output – risk, benefit, and approach
              </h2>

              {!result ? (
                <p className="text-sm text-slate-500">
                  Enter patient details and click{" "}
                  <span className="font-semibold">“Run recommendation”</span> to view
                  estimates.
                </p>
              ) : (
                <div className="space-y-4 text-sm">
                  <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                      Overall recommendation
                    </p>
                    <p className="mt-1 text-base font-semibold text-emerald-900">
                      {result.recommendationLabel}
                    </p>
                    <p className="mt-1 text-xs text-emerald-800">
                      This is a guide based on modeled risk / benefit and does not replace
                      surgeon judgment or patient preference.
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                        Risk without surgery
                      </h3>
                      <p className="mt-1 text-2xl font-semibold text-rose-600">
                        {result.riskScore.toFixed(0)}%
                      </p>
                      <p className="mt-1 text-xs text-slate-700">{result.riskText}</p>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                        Expected chance of meaningful improvement with surgery
                      </h3>
                      <p className="mt-1 text-2xl font-semibold text-emerald-600">
                        {result.benefitScore.toFixed(0)}%
                      </p>
                      <p className="mt-1 text-xs text-slate-700">{result.benefitText}</p>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-500">
                    <span className="font-semibold">Important caveats:</span>{" "}
                    These risk and benefit estimates do not include all clinical factors
                    (frailty, detailed alignment, prior surgery, specific comorbidities)
                    and should always be interpreted together with clinical examination
                    and full imaging review.
                  </p>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                      If surgery is offered, which approach?
                    </h3>

                    <div className="mt-2 grid gap-3 md:grid-cols-3">
                      {(["anterior", "posterior", "circumferential"] as ApproachKey[]).map(
                        (key) => {
                          const p = result.approachProbs[key];
                          const isBest = result.bestApproach === key;
                          return (
                            <div
                              key={key}
                              className={`rounded-lg border px-3 py-2 text-xs ${
                                isBest
                                  ? "border-emerald-500 bg-emerald-50"
                                  : "border-slate-200 bg-white"
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <p className="font-semibold capitalize text-slate-800">
                                  {key}
                                </p>
                                <p className="text-sm font-semibold text-slate-900">
                                  {(p * 100).toFixed(0)}%
                                </p>
                              </div>
                              {isBest && (
                                <p className="mt-1 text-[11px] font-medium text-emerald-700">
                                  Best estimated balance of improvement and risk
                                </p>
                              )}
                              {!isBest && (
                                <p className="mt-1 text-[11px] text-slate-600">
                                  Lower modeled probability compared with the leading
                                  approach.
                                </p>
                              )}
                            </div>
                          );
                        }
                      )}
                    </div>

                    <p className="mt-2 text-[11px] text-slate-600">
                      {result.uncertainty === "low" && (
                        <>
                          <span className="font-semibold text-emerald-700">
                            Uncertainty: Low
                          </span>
                          {" – model strongly favors the highlighted approach."}
                        </>
                      )}
                      {result.uncertainty === "moderate" && (
                        <>
                          <span className="text-amber-700 font-semibold">
                            Moderate uncertainty
                          </span>
                          {
                            " – anterior and posterior strategies are reasonably close; surgeon experience and alignment goals are important."
                          }
                        </>
                      )}
                      {result.uncertainty === "high" && (
                        <>
                          <span className="text-rose-700 font-semibold">
                            High uncertainty
                          </span>
                          {
                            " – predicted benefits are very similar across approaches, emphasizing the need for individualized discussion."
                          }
                        </>
                      )}
                    </p>
                  </div>
                </div>
              )}
            </section>
          </>
        ) : (
          // ---------- Batch tab ----------
          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="mb-2 text-lg font-semibold text-slate-900">Batch (CSV)</h2>
            <p className="mb-3 text-sm text-slate-600">
              Upload a CSV file or paste data with one row per patient using this header
              (order can match your export):
            </p>
            <pre className="mb-3 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-[11px] text-emerald-100">
              age,sex,smoker,symptom_duration_months,severity,baseline_mJOA,levels_operated,
              canal_occupying_ratio_cat,T2_signal,OPLL,T1_hypointensity,gait_impa
              irment,psych_disorder,baseline_NDI,baseline_SF36_PCS,baseline_SF36_MCS
            </pre>

            <textarea
              className="h-48 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs text-slate-800"
              placeholder={`age,sex,smoker,symptom_duration_mont...,psych_disorder,baseline_NDI,baseline_SF36_PCS,baseline_SF36_MCS
65,M,0,12,moderate,13,3,50–60%,multilevel,0,0,1,0,40,40,45`}
              value={batchCsv}
              onChange={(e) => setBatchCsv(e.target.value)}
            />

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleRunBatch}
                disabled={batchLoading}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {batchLoading ? "Running..." : "Run batch recommendations"}
              </button>
              <button
                type="button"
                onClick={handlePrintBatchSummary}
                disabled={!batchResults || batchResults.length === 0}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                Save batch summary (PDF)
              </button>
              <button
                type="button"
                onClick={handlePrintBatchView}
                disabled={!batchResults || batchResults.length === 0}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                Print batch view
              </button>
            </div>

            {batchError && (
              <p className="mt-3 text-sm text-rose-600">
                <span className="font-semibold">Batch error: </span>
                {batchError}
              </p>
            )}

            {batchResults && batchResults.length > 0 && (
              <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-2 py-1 text-left font-semibold text-slate-700">
                        Row
                      </th>
                      <th className="px-2 py-1 text-left font-semibold text-slate-700">
                        Age
                      </th>
                      <th className="px-2 py-1 text-left font-semibold text-slate-700">
                        mJOA
                      </th>
                      <th className="px-2 py-1 text-left font-semibold text-slate-700">
                        Severity
                      </th>
                      <th className="px-2 py-1 text-left font-semibold text-slate-700">
                        Risk w/o surgery
                      </th>
                      <th className="px-2 py-1 text-left font-semibold text-slate-700">
                        Benefit w/ surgery
                      </th>
                      <th className="px-2 py-1 text-left font-semibold text-slate-700">
                        Recommendation
                      </th>
                      <th className="px-2 py-1 text-left font-semibold text-slate-700">
                        Best approach
                      </th>
                      <th className="px-2 py-1 text-left font-semibold text-slate-700">
                        Error
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {batchResults.map((row) => (
                      <tr key={row.index}>
                        <td className="px-2 py-1 text-slate-800">{row.index}</td>
                        <td className="px-2 py-1 text-slate-800">
                          {row.age != null ? row.age : "-"}
                        </td>
                        <td className="px-2 py-1 text-slate-800">
                          {row.baselineMJOA != null ? row.baselineMJOA : "-"}
                        </td>
                        <td className="px-2 py-1 capitalize text-slate-800">
                          {row.severity || "-"}
                        </td>
                        <td className="px-2 py-1 text-slate-800">
                          {row.riskScore != null ? `${row.riskScore.toFixed(0)}%` : "-"}
                        </td>
                        <td className="px-2 py-1 text-slate-800">
                          {row.benefitScore != null ? `${row.benefitScore.toFixed(0)}%` : "-"}
                        </td>
                        <td className="px-2 py-1 text-slate-800">
                          {row.recommendationLabel}
                        </td>
                        <td className="px-2 py-1 capitalize text-slate-800">
                          {row.bestApproach || "-"}
                        </td>
                        <td className="px-2 py-1 text-rose-600">
                          {row.error ? row.error : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
