"use client";

import React, { useState, useMemo } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Upload,
  Download,
  FileText,
  Info,
  Loader2,
} from "lucide-react";
import jsPDF from "jspdf";

type Severity = "mild" | "moderate" | "severe";
type ApproachKey = "anterior" | "posterior" | "circumferential";
type BestApproachKey = ApproachKey | "none";

type UncertaintyLevel = "low" | "moderate" | "high";

interface ApproachProbs {
  anterior: number;
  posterior: number;
  circumferential: number;
}

interface SingleResult {
  normalizedInput: Record<string, unknown>;
  pSurgeryRule: number;
  pSurgeryMl: number;
  pSurgeryCombined: number;
  surgeryRecommended: boolean;
  recommendationLabel: string;
  pMcidMl: number;
  riskScore: number;
  benefitScore: number;
  riskText: string;
  benefitText: string;
  approachProbsRule: ApproachProbs;
  approachProbsMl: ApproachProbs;
  approachProbs: ApproachProbs;
  bestApproach: BestApproachKey;
  bestApproachProb: number;
  secondBestApproachProb: number;
  uncertaintyLevel: UncertaintyLevel;
  ruleBestApproach: ApproachKey;
}

interface BatchRowResult extends SingleResult {
  index: number;
}

type Mode = "single" | "batch";

function formatPercent(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return "–";
  const v = Math.round(p * 100);
  return `${v}%`;
}

function classNames(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

function severityColor(sev: Severity): string {
  switch (sev) {
    case "mild":
      return "bg-emerald-50 text-emerald-900 border-emerald-200";
    case "moderate":
      return "bg-amber-50 text-amber-900 border-amber-200";
    case "severe":
      return "bg-rose-50 text-rose-900 border-rose-200";
    default:
      return "bg-slate-50 text-slate-900 border-slate-200";
  }
}

function uncertaintyExplainer(level: UncertaintyLevel): string {
  if (level === "low") {
    return "The model and rules point clearly toward one approach; probabilities are well separated.";
  }
  if (level === "moderate") {
    return "Two approaches are reasonably close; clinical judgment and anatomy should weigh heavily.";
  }
  return "Approach probabilities are similar; this is a gray zone where surgeon preference, alignment goals, and patient factors are critical.";
}

function riskBandColor(score: number): string {
  if (score < 30) return "bg-emerald-500";
  if (score < 60) return "bg-amber-500";
  return "bg-rose-500";
}

function benefitBandColor(score: number): string {
  if (score < 30) return "bg-slate-400";
  if (score < 60) return "bg-sky-500";
  return "bg-emerald-500";
}

function approachColor(key: ApproachKey): string {
  if (key === "anterior") return "bg-sky-100 text-sky-900 border-sky-200";
  if (key === "posterior") return "bg-indigo-100 text-indigo-900 border-indigo-200";
  return "bg-fuchsia-100 text-fuchsia-900 border-fuchsia-200";
}

/**
 * Simple PDF summary generator for a single result.
 */
function generatePdfSummary(result: SingleResult) {
  const doc = new jsPDF();
  let y = 15;
  doc.setFontSize(14);
  doc.text("Degenerative Cervical Myelopathy – Decision Summary", 10, y);
  y += 8;

  doc.setFontSize(11);
  doc.text("Patient inputs:", 10, y);
  y += 6;

  const inputEntries = Object.entries(result.normalizedInput || {});
  inputEntries.forEach(([k, v]) => {
    const line = `• ${k}: ${String(v)}`;
    doc.text(line, 12, y);
    y += 5;
    if (y > 270) {
      doc.addPage();
      y = 15;
    }
  });

  y += 4;
  doc.setFontSize(11);
  doc.text("1) Should this patient undergo surgery?", 10, y);
  y += 6;
  doc.setFontSize(10);
  doc.text(`Recommendation: ${result.recommendationLabel}`, 12, y);
  y += 5;
  doc.text(
    `P(surgery, hybrid) ≈ ${formatPercent(result.pSurgeryCombined)}`,
    12,
    y
  );
  y += 6;

  doc.text(
    `Risk without surgery: ${result.riskScore}/100 – ${result.riskText}`,
    12,
    y
  );
  y += 8;
  doc.text(
    `Estimated probability of mJOA MCID: ${formatPercent(
      result.pMcidMl
    )} – ${result.benefitText}`,
    12,
    y
  );
  y += 10;

  doc.setFontSize(11);
  doc.text("2) If surgery is offered, which approach?", 10, y);
  y += 6;
  doc.setFontSize(10);

  const ap = result.approachProbs;
  doc.text(
    `Approach probabilities (hybrid): ANT ${formatPercent(
      ap.anterior
    )}, POST ${formatPercent(ap.posterior)}, 360° ${formatPercent(
      ap.circumferential
    )}`,
    12,
    y
  );
  y += 5;
  doc.text(
    `Suggested primary approach: ${
      result.bestApproach === "none"
        ? "none (non-operative)"
        : result.bestApproach.toUpperCase()
    }`,
    12,
    y
  );
  y += 5;
  doc.text(
    `Uncertainty band: ${result.uncertaintyLevel.toUpperCase()} – ${uncertaintyExplainer(
      result.uncertaintyLevel
    )}`,
    12,
    y
  );
  y += 10;

  doc.setFontSize(9);
  doc.text(
    "NOTE: Hybrid engine combines AO Spine/WFNS concepts with synthetic ML models trained on large simulated DCM cohorts.",
    10,
    y
  );

  doc.save("dcm_decision_summary.pdf");
}

/**
 * Main prototype page
 */
export default function PrototypePage() {
  const [mode, setMode] = useState<Mode>("single");
  const [severity, setSeverity] = useState<Severity>("moderate");
  const [mJOA, setMJOA] = useState<number>(12);
  const [singleLoading, setSingleLoading] = useState(false);
  const [batchLoading, setBatchLoading] = useState(false);
  const [singleResult, setSingleResult] = useState<SingleResult | null>(null);
  const [batchResults, setBatchResults] = useState<BatchRowResult[]>([]);
  const [batchFileName, setBatchFileName] = useState<string | null>(null);

  // Simple severity auto-mapping from mJOA if you tweak the slider
  const derivedSeverity: Severity = useMemo(() => {
    if (mJOA >= 15) return "mild";
    if (mJOA >= 12) return "moderate";
    return "severe";
  }, [mJOA]);

  // Ensure severity and slider stay consistent
  const displaySeverity = severity || derivedSeverity;

  async function handleSingleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSingleLoading(true);
    try {
      const form = e.target as HTMLFormElement;
      const data = new FormData(form);

      const payload: Record<string, unknown> = {
        age: Number(data.get("age") || 65),
        sex: data.get("sex") || "M",
        smoker: Number(data.get("smoker") || 0),
        symptom_duration_months: Number(
          data.get("symptom_duration_months") || 12
        ),
        severity: displaySeverity,
        baseline_mJOA: Number(data.get("baseline_mJOA") || mJOA),
        levels_operated: Number(data.get("levels_operated") || 3),
        OPLL: Number(data.get("OPLL") || 0),
        canal_occupying_ratio_cat:
          (data.get("canal_occupying_ratio_cat") as string) || "50-60%",
        T2_signal: (data.get("T2_signal") as string) || "multilevel",
        T1_hypointensity: Number(data.get("T1_hypointensity") || 0),
        gait_impairment: Number(data.get("gait_impairment") || 1),
        psych_disorder: Number(data.get("psych_disorder") || 0),
        baseline_NDI: Number(data.get("baseline_NDI") || 40),
        baseline_SF36_PCS: Number(data.get("baseline_SF36_PCS") || 40),
        baseline_SF36_MCS: Number(data.get("baseline_SF36_MCS") || 45),
      };

      const res = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(`API error ${res.status}`);
      }

      const json = await res.json();

      const result: SingleResult = {
        normalizedInput: json.normalized_input ?? payload,
        pSurgeryRule: json.p_surgery_rule ?? 0,
        pSurgeryMl: json.p_surgery_ml ?? 0,
        pSurgeryCombined: json.p_surgery_combined ?? 0,
        surgeryRecommended: json.surgery_recommended ?? false,
        recommendationLabel:
          json.recommendation_label ?? "Recommendation unavailable",
        pMcidMl: json.p_MCID_mJOA_ml ?? 0,
        riskScore: json.risk_score ?? 0,
        benefitScore: json.benefit_score ?? 0,
        riskText:
          json.risk_text ??
          "Risk explanation placeholder – will be replaced by calibrated text.",
        benefitText:
          json.benefit_text ??
          "Benefit explanation placeholder – will be replaced by calibrated text.",
        approachProbsRule: json.approach_probs_rule ?? {
          anterior: 0,
          posterior: 0,
          circumferential: 0,
        },
        approachProbsMl: json.approach_probs_ml ?? {
          anterior: 0,
          posterior: 0,
          circumferential: 0,
        },
        approachProbs: json.approach_probs ?? {
          anterior: 0,
          posterior: 0,
          circumferential: 0,
        },
        bestApproach: (json.best_approach as BestApproachKey) ?? "none",
        bestApproachProb: json.best_approach_prob ?? 0,
        secondBestApproachProb: json.second_best_approach_prob ?? 0,
        uncertaintyLevel:
          (json.uncertainty_level as UncertaintyLevel) ?? "moderate",
        ruleBestApproach:
          (json.rule_best_approach as ApproachKey) ?? "posterior",
      };

      setSingleResult(result);
    } catch (err) {
      console.error(err);
      setSingleResult(null);
    } finally {
      setSingleLoading(false);
    }
  }

  async function handleBatchFileChange(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBatchFileName(file.name);
    setBatchLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/batch-recommend", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        throw new Error(`Batch API error ${res.status}`);
      }
      const json = await res.json();

      const rows: BatchRowResult[] = (json.rows ?? []).map(
        (row: any, idx: number) => ({
          index: idx,
          normalizedInput: row.normalized_input ?? {},
          pSurgeryRule: row.p_surgery_rule ?? 0,
          pSurgeryMl: row.p_surgery_ml ?? 0,
          pSurgeryCombined: row.p_surgery_combined ?? 0,
          surgeryRecommended: row.surgery_recommended ?? false,
          recommendationLabel:
            row.recommendation_label ?? "Recommendation unavailable",
          pMcidMl: row.p_MCID_mJOA_ml ?? 0,
          riskScore: row.risk_score ?? 0,
          benefitScore: row.benefit_score ?? 0,
          riskText:
            row.risk_text ??
            "Risk explanation placeholder – will be replaced by calibrated text.",
          benefitText:
            row.benefit_text ??
            "Benefit explanation placeholder – will be replaced by calibrated text.",
          approachProbsRule: row.approach_probs_rule ?? {
            anterior: 0,
            posterior: 0,
            circumferential: 0,
          },
          approachProbsMl: row.approach_probs_ml ?? {
            anterior: 0,
            posterior: 0,
            circumferential: 0,
          },
          approachProbs: row.approach_probs ?? {
            anterior: 0,
            posterior: 0,
            circumferential: 0,
          },
          bestApproach: (row.best_approach as BestApproachKey) ?? "none",
          bestApproachProb: row.best_approach_prob ?? 0,
          secondBestApproachProb: row.second_best_approach_prob ?? 0,
          uncertaintyLevel:
            (row.uncertainty_level as UncertaintyLevel) ?? "moderate",
          ruleBestApproach:
            (row.rule_best_approach as ApproachKey) ?? "posterior",
        })
      );

      setBatchResults(rows);
    } catch (err) {
      console.error(err);
      setBatchResults([]);
    } finally {
      setBatchLoading(false);
    }
  }

  function renderApproachBars(approach_probs: ApproachProbs, best: BestApproachKey) {
    // FIX: Strongly type the tuple array
    const vals: [ApproachKey, number][] = [
      ["anterior", approach_probs.anterior ?? 0],
      ["posterior", approach_probs.posterior ?? 0],
      ["circumferential", approach_probs.circumferential ?? 0],
    ];

    return (
      <div className="space-y-2">
        {vals.map(([key, val]) => {
          const pct = Math.round((val ?? 0) * 100);
          const isBest = best !== "none" && best === key;
          return (
            <div key={key} className="space-y-1">
              <div className="flex justify-between text-xs font-medium text-slate-500 uppercase tracking-wide">
                <span>
                  {key === "anterior"
                    ? "ANTERIOR"
                    : key === "posterior"
                    ? "POSTERIOR"
                    : "360° / CIRCUMFERENTIAL"}
                </span>
                <span>{pct}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                <div
                  className={classNames(
                    "h-full rounded-full transition-all",
                    key === "anterior" && "bg-sky-500",
                    key === "posterior" && "bg-indigo-500",
                    key === "circumferential" && "bg-fuchsia-500"
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {isBest && (
                <p className="text-[10px] text-emerald-700 font-semibold">
                  Primary approach suggested by hybrid engine
                </p>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  const riskTag = useMemo(() => {
    if (!singleResult) return "";
    if (singleResult.riskScore < 30) return "Low baseline progression risk";
    if (singleResult.riskScore < 60) return "Intermediate progression risk";
    return "High progression risk without decompression";
  }, [singleResult]);

  const benefitTag = useMemo(() => {
    if (!singleResult) return "";
    if (singleResult.benefitScore < 30) return "Limited expected functional gain";
    if (singleResult.benefitScore < 60)
      return "Moderate chance of clinically meaningful improvement";
    return "High chance of clinically meaningful improvement";
  }, [singleResult]);

  return (
    <main className="min-h-screen bg-slate-50">
      {/* Top bar with logo + clinic name centered */}
      <header className="border-b bg-gradient-to-r from-slate-50 via-sky-50 to-slate-50">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-4 flex items-center justify-between gap-4">
          <Link
            href="/"
            className="inline-flex items-center text-sm text-slate-500 hover:text-slate-700"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back
          </Link>
          <div className="flex flex-col items-center justify-center text-center">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="absolute inset-0 rounded-full blur-md bg-sky-200/40" />
                <img
                  src="/ascension-seton-logo.png"
                  alt="Ascension Texas Spine and Scoliosis"
                  className="relative h-16 md:h-20 w-auto mix-blend-multiply"
                />
              </div>
              <h1 className="text-lg md:text-2xl font-semibold text-slate-900">
                Ascension Texas Spine and Scoliosis
              </h1>
            </div>
            <p className="mt-1 text-xs md:text-sm text-slate-500 max-w-xl">
              Degenerative Cervical Myelopathy (DCM) – Hybrid guideline + ML–driven
              surgery decision support (early clinical prototype).
            </p>
          </div>
          <div className="w-16" />
        </div>
      </header>

      <section className="max-w-6xl mx-auto px-4 md:px-8 py-8 space-y-8">
        {/* Tabs: single vs batch */}
        <div className="inline-flex rounded-full bg-slate-200 p-1 text-xs md:text-sm">
          <button
            type="button"
            onClick={() => setMode("single")}
            className={classNames(
              "px-4 py-1.5 rounded-full transition-all",
              mode === "single"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-800"
            )}
          >
            Single patient
          </button>
          <button
            type="button"
            onClick={() => setMode("batch")}
            className={classNames(
              "px-4 py-1.5 rounded-full transition-all",
              mode === "batch"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-800"
            )}
          >
            Batch (CSV)
          </button>
        </div>

        {/* Main content grid */}
        <div className="grid md:grid-cols-2 gap-6 md:gap-8 items-start">
          {/* LEFT: INPUTS */}
          <div className="space-y-4">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 md:p-6">
              <h2 className="text-base md:text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-sky-100 text-sky-700 text-xs font-bold">
                  1
                </span>
                Patient inputs
              </h2>

              {mode === "single" ? (
                <form className="space-y-4 text-sm" onSubmit={handleSingleSubmit}>
                  {/* Row: age / sex / smoker */}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Age (years)
                      </label>
                      <input
                        name="age"
                        type="number"
                        defaultValue={65}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Sex
                      </label>
                      <select
                        name="sex"
                        defaultValue="M"
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      >
                        <option value="M">Male</option>
                        <option value="F">Female</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Smoker
                      </label>
                      <select
                        name="smoker"
                        defaultValue={0}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      >
                        <option value={0}>No</option>
                        <option value={1}>Yes</option>
                      </select>
                    </div>
                  </div>

                  {/* Symptom duration & severity / mJOA */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Symptom duration (months)
                      </label>
                      <input
                        name="symptom_duration_months"
                        type="number"
                        defaultValue={12}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Baseline mJOA
                      </label>
                      <input
                        name="baseline_mJOA"
                        type="number"
                        value={mJOA}
                        min={5}
                        max={18}
                        step={0.5}
                        onChange={(e) => setMJOA(parseFloat(e.target.value))}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      />
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        Severity auto-derives from mJOA but can be conceptually
                        mapped to mild / moderate / severe.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3 items-center">
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        mJOA–based severity
                      </label>
                      <div className="flex items-center gap-2">
                        <div
                          className={classNames(
                            "px-2 py-1 rounded-lg border text-xs font-medium",
                            severityColor(derivedSeverity)
                          )}
                        >
                          {derivedSeverity.toUpperCase()}
                        </div>
                        <button
                          type="button"
                          className="inline-flex items-center text-[10px] text-slate-500 hover:text-slate-700"
                          onClick={() => setSeverity(derivedSeverity)}
                        >
                          Use as severity tag
                        </button>
                      </div>
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        Mild: &gt;=15 | Moderate: 12–14.5 | Severe: &lt;12
                      </p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Levels operated (planned)
                      </label>
                      <input
                        name="levels_operated"
                        type="number"
                        defaultValue={3}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      />
                    </div>
                  </div>

                  {/* Imaging & cord signal */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Canal occupying ratio
                      </label>
                      <select
                        name="canal_occupying_ratio_cat"
                        defaultValue="50-60%"
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      >
                        <option value="<50%">&lt;50%</option>
                        <option value="50-60%">50–60%</option>
                        <option value=">60%">&gt;60%</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        T2 cord signal
                      </label>
                      <select
                        name="T2_signal"
                        defaultValue="multilevel"
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      >
                        <option value="none">None</option>
                        <option value="focal">Focal</option>
                        <option value="multilevel">Multilevel</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        OPLL
                      </label>
                      <select
                        name="OPLL"
                        defaultValue={0}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      >
                        <option value={0}>No</option>
                        <option value={1}>Yes</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        T1 hypointensity
                      </label>
                      <select
                        name="T1_hypointensity"
                        defaultValue={0}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      >
                        <option value={0}>No</option>
                        <option value={1}>Yes</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Gait impairment
                      </label>
                      <select
                        name="gait_impairment"
                        defaultValue={1}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      >
                        <option value={0}>No</option>
                        <option value={1}>Yes</option>
                      </select>
                    </div>
                  </div>

                  {/* Baseline PROs */}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Baseline NDI
                      </label>
                      <input
                        name="baseline_NDI"
                        type="number"
                        defaultValue={40}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        SF-36 PCS
                      </label>
                      <input
                        name="baseline_SF36_PCS"
                        type="number"
                        defaultValue={40}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        SF-36 MCS
                      </label>
                      <input
                        name="baseline_SF36_MCS"
                        type="number"
                        defaultValue={45}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={singleLoading}
                    className="mt-4 inline-flex items-center justify-center rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-sky-700 disabled:opacity-60"
                  >
                    {singleLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Running recommendation…
                      </>
                    ) : (
                      "Run recommendation"
                    )}
                  </button>
                </form>
              ) : (
                <div className="space-y-4 text-sm">
                  <p className="text-slate-600">
                    Upload a{" "}
                    <span className="font-semibold">CSV file</span> with one row
                    per patient. Required columns:
                  </p>
                  <ul className="list-disc pl-5 text-xs text-slate-600 space-y-1">
                    <li>
                      <code>age, sex, smoker, symptom_duration_months</code>
                    </li>
                    <li>
                      <code>
                        severity, baseline_mJOA, levels_operated, OPLL,
                        canal_occupying_ratio_cat, T2_signal, T1_hypointensity,
                        gait_impairment, psych_disorder
                      </code>
                    </li>
                    <li>
                      <code>
                        baseline_NDI, baseline_SF36_PCS, baseline_SF36_MCS
                      </code>
                    </li>
                  </ul>

                  <label className="flex flex-col items-center justify-center border border-dashed border-sky-300 rounded-2xl px-4 py-6 bg-sky-50/60 text-sky-800 cursor-pointer hover:border-sky-400 hover:bg-sky-50 transition">
                    <Upload className="w-6 h-6 mb-2" />
                    <span className="text-xs font-semibold">
                      {batchFileName || "Click to upload CSV"}
                    </span>
                    <span className="text-[10px] text-sky-700 mt-0.5">
                      File stays local to Ascension workflow; no PHI is stored
                      in this prototype.
                    </span>
                    <input
                      type="file"
                      accept=".csv"
                      className="hidden"
                      onChange={handleBatchFileChange}
                    />
                  </label>

                  {batchLoading && (
                    <p className="text-xs text-slate-500 flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Processing batch…
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Methodology summary card */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4 text-xs text-slate-600 space-y-2">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4 text-sky-600" />
                <p className="font-semibold text-slate-800">
                  Hybrid guideline + ML engine (development phase)
                </p>
              </div>
              <p>
                This tool blends AO Spine / WFNS guideline concepts (myelopathy
                severity, cord signal, canal compromise, OPLL, gait) with
                machine-learning models trained on large synthetic DCM cohorts
                based on published outcome rates. It is{" "}
                <span className="font-semibold">
                  not yet calibrated on real Ascension Texas data
                </span>{" "}
                and is intended only to structure discussions, not replace
                surgeon judgment.
              </p>
            </div>
          </div>

          {/* RIGHT: OUTPUTS */}
          <div className="space-y-4">
            {/* 1) Should this patient undergo surgery? */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 md:p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base md:text-lg font-semibold text-slate-900 flex items-center gap-2">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold">
                    1
                  </span>
                  <span className="text-emerald-800">
                    Should this patient undergo surgery?
                  </span>
                </h2>
                {singleResult && (
                  <span
                    className={classNames(
                      "px-2.5 py-1 rounded-full text-[11px] font-semibold border",
                      singleResult.surgeryRecommended
                        ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                        : "bg-slate-50 text-slate-700 border-slate-200"
                    )}
                  >
                    {singleResult.surgeryRecommended ? "Surgery favoured" : "Non-op acceptable"}
                  </span>
                )}
              </div>

              {!singleResult && mode === "single" && (
                <p className="text-sm text-slate-500">
                  Run a single-patient recommendation on the left to see
                  surgery vs non-operative probabilities, risk bands, and
                  expected benefit.
                </p>
              )}

              {!singleResult && mode === "batch" && (
                <p className="text-sm text-slate-500">
                  After uploading a CSV, batch-level distributions will be
                  summarized here and below.
                </p>
              )}

              {singleResult && (
                <div className="space-y-3 text-sm">
                  <p className="font-semibold text-slate-900">
                    {singleResult.recommendationLabel}
                  </p>

                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] text-slate-500">
                        P(surgery – rule-based)
                      </p>
                      <p className="text-lg font-semibold text-slate-900">
                        {formatPercent(singleResult.pSurgeryRule)}
                      </p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] text-slate-500">
                        P(surgery – ML)
                      </p>
                      <p className="text-lg font-semibold text-slate-900">
                        {formatPercent(singleResult.pSurgeryMl)}
                      </p>
                    </div>
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
                      <p className="text-[11px] text-emerald-700">
                        P(surgery – hybrid)
                      </p>
                      <p className="text-lg font-semibold text-emerald-800">
                        {formatPercent(singleResult.pSurgeryCombined)}
                      </p>
                    </div>
                  </div>

                  {/* Risk vs benefit dial */}
                  <div className="mt-2 grid grid-cols-2 gap-4 text-xs">
                    <div className="space-y-1">
                      <p className="text-[11px] font-semibold text-slate-700">
                        Risk without surgery
                      </p>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 rounded-full bg-slate-200 overflow-hidden">
                          <div
                            className={classNames(
                              "h-full rounded-full",
                              riskBandColor(singleResult.riskScore)
                            )}
                            style={{
                              width: `${singleResult.riskScore}%`,
                            }}
                          />
                        </div>
                        <span className="text-[11px] text-slate-700 font-semibold w-10 text-right">
                          {singleResult.riskScore}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600">{riskTag}</p>
                    </div>

                    <div className="space-y-1">
                      <p className="text-[11px] font-semibold text-slate-700">
                        Expected benefit with surgery
                      </p>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 rounded-full bg-slate-200 overflow-hidden">
                          <div
                            className={classNames(
                              "h-full rounded-full",
                              benefitBandColor(singleResult.benefitScore)
                            )}
                            style={{
                              width: `${singleResult.benefitScore}%`,
                            }}
                          />
                        </div>
                        <span className="text-[11px] text-slate-700 font-semibold w-10 text-right">
                          {singleResult.benefitScore}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600">
                        {benefitTag} (mJOA MCID model)
                      </p>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-3 text-[11px] text-slate-600">
                    <div className="bg-slate-50 rounded-xl border border-slate-200 p-2">
                      <p className="font-semibold text-slate-800 mb-1">
                        Risk narrative
                      </p>
                      <p>{singleResult.riskText}</p>
                    </div>
                    <div className="bg-slate-50 rounded-xl border border-slate-200 p-2">
                      <p className="font-semibold text-slate-800 mb-1">
                        Benefit narrative
                      </p>
                      <p>{singleResult.benefitText}</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => generatePdfSummary(singleResult)}
                    className="mt-2 inline-flex items-center rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <Download className="w-3 h-3 mr-1.5" />
                    Download one-page PDF summary
                  </button>
                </div>
              )}

              {mode === "batch" && batchResults.length > 0 && (
                <div className="mt-3 text-xs text-slate-600 space-y-2">
                  <p className="font-semibold text-slate-800">
                    Batch overview ({batchResults.length} patients)
                  </p>
                  <p>
                    The majority of patients fall into surgery-favored
                    categories based on severity, duration, and MRI surrogates.
                    Use the batch table below to spot cases where surgery is
                    not clearly indicated or where approach uncertainty is high.
                  </p>
                </div>
              )}
            </div>

            {/* 2) If surgery is offered, which approach? */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 md:p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base md:text-lg font-semibold text-slate-900 flex items-center gap-2">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold">
                    2
                  </span>
                  <span className="text-indigo-800">
                    If surgery is offered, which approach?
                  </span>
                </h2>
                {singleResult && (
                  <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold border bg-slate-50 text-slate-700 border-slate-200">
                    Uncertainty: {singleResult.uncertaintyLevel}
                  </span>
                )}
              </div>

              {!singleResult && mode === "single" && (
                <p className="text-sm text-slate-500">
                  Run a recommendation to see anterior vs posterior vs
                  circumferential probability bands. Uncertainty reflects how
                  close these probabilities are to each other: low = one clear
                  favorite, high = several similar options.
                </p>
              )}

              {singleResult && (
                <div className="space-y-3 text-sm">
                  {singleResult.bestApproach === "none" ? (
                    <p className="text-slate-700">
                      For this scenario the engine does{" "}
                      <span className="font-semibold">
                        not suggest a surgical approach
                      </span>{" "}
                      because a non-operative trial remains reasonable or
                      probability of meaningful benefit is low.
                    </p>
                  ) : (
                    <p className="text-slate-700">
                      Hybrid rules + ML currently favor{" "}
                      <span className="font-semibold">
                        {singleResult.bestApproach.toUpperCase()}
                      </span>{" "}
                      as the primary approach, with probability{" "}
                      <span className="font-semibold">
                        {formatPercent(singleResult.bestApproachProb)}
                      </span>
                      . The second-best option has probability{" "}
                      <span className="font-semibold">
                        {formatPercent(singleResult.secondBestApproachProb)}
                      </span>
                      .
                    </p>
                  )}

                  <div className="grid grid-cols-3 gap-3 text-xs">
                    {(["anterior", "posterior", "circumferential"] as ApproachKey[]).map(
                      (k) => {
                        const label =
                          k === "anterior"
                            ? "ANTERIOR"
                            : k === "posterior"
                            ? "POSTERIOR"
                            : "360° / CIRCUMFERENTIAL";
                        const isBest =
                          singleResult.bestApproach !== "none" &&
                          singleResult.bestApproach === k;
                        const pct = Math.round(
                          singleResult.approachProbs[k] * 100
                        );
                        return (
                          <div
                            key={k}
                            className={classNames(
                              "rounded-xl border px-3 py-2.5 space-y-1",
                              approachColor(k),
                              isBest && "ring-2 ring-offset-2 ring-emerald-500"
                            )}
                          >
                            <p className="text-[11px] font-semibold">
                              {label}
                            </p>
                            <p className="text-lg font-semibold">
                              {pct}%
                            </p>
                            <p className="text-[10px] opacity-80">
                              {k === "anterior"
                                ? "Shorter construct, ventral decompression, but higher dysphagia risk."
                                : k === "posterior"
                                ? "Posterior multilevel decompression with higher C5 palsy/wound risks."
                                : "Selected in rare, complex OPLL/multiplanar deformity cases."}
                            </p>
                          </div>
                        );
                      }
                    )}
                  </div>

                  <div className="mt-2">
                    <p className="text-[11px] font-semibold text-slate-800 mb-1">
                      Probability bands and “uncertainty”
                    </p>
                    <p className="text-[11px] text-slate-600">
                      Uncertainty summarizes how close the approach
                      probabilities are.{" "}
                      <span className="font-semibold">Low uncertainty</span>{" "}
                      means one approach clearly dominates.{" "}
                      <span className="font-semibold">High uncertainty</span>{" "}
                      means probabilities are similar, and surgeon judgment,
                      sagittal/coronal goals, and patient factors should drive
                      the choice more than the model.
                    </p>
                  </div>

                  <div className="mt-2">
                    {renderApproachBars(
                      singleResult.approachProbs,
                      singleResult.bestApproach
                    )}
                  </div>
                </div>
              )}

              {mode === "batch" && batchResults.length > 0 && (
                <div className="mt-3 text-xs text-slate-600 space-y-2">
                  <p className="font-semibold text-slate-800">
                    Batch approach overview
                  </p>
                  <p>
                    Below, each row shows the suggested primary approach,
                    hybrid surgery probability, and uncertainty level. Sort or
                    filter in your analytics environment to identify discordant
                    or gray-zone cases for MDT discussion.
                  </p>
                </div>
              )}
            </div>

            {/* Batch table if in batch mode */}
            {mode === "batch" && batchResults.length > 0 && (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 text-xs">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-slate-600" />
                    <p className="font-semibold text-slate-800">
                      Batch recommendations (first 20 shown)
                    </p>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Export from back-end or analytics notebook as needed.
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-[11px] text-left">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                        <th className="px-2 py-1 font-medium">#</th>
                        <th className="px-2 py-1 font-medium">Severity</th>
                        <th className="px-2 py-1 font-medium">
                          P(surg, hybrid)
                        </th>
                        <th className="px-2 py-1 font-medium">Approach</th>
                        <th className="px-2 py-1 font-medium">Uncertainty</th>
                        <th className="px-2 py-1 font-medium">
                          P(MCID mJOA)
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchResults.slice(0, 20).map((r) => {
                        const sev =
                          (r.normalizedInput["severity"] as Severity) ??
                          "moderate";
                        return (
                          <tr
                            key={r.index}
                            className="border-b border-slate-100 hover:bg-slate-50/60"
                          >
                            <td className="px-2 py-1 text-slate-500">
                              {r.index + 1}
                            </td>
                            <td className="px-2 py-1">
                              <span
                                className={classNames(
                                  "px-1.5 py-0.5 rounded-full border text-[10px] font-semibold uppercase",
                                  severityColor(sev)
                                )}
                              >
                                {sev}
                              </span>
                            </td>
                            <td className="px-2 py-1">
                              {formatPercent(r.pSurgeryCombined)}
                            </td>
                            <td className="px-2 py-1">
                              {r.bestApproach === "none"
                                ? "None"
                                : r.bestApproach.toUpperCase()}
                            </td>
                            <td className="px-2 py-1">
                              {r.uncertaintyLevel}
                            </td>
                            <td className="px-2 py-1">
                              {formatPercent(r.pMcidMl)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
