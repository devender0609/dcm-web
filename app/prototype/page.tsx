// app/prototype/page.tsx
"use client";

import { useState, useMemo, ChangeEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, Upload, FileDown } from "lucide-react";

// -----------------------------
// Types
// -----------------------------
type SeveritySlug = "mild" | "moderate" | "severe";

interface PatientInput {
  age: number;
  sex: "M" | "F";
  mJOA: number;
  symptomDurationMonths: number;
  t2Signal: "none" | "focal" | "multilevel";
  plannedLevels: number;
  canalOccupying: "<50%" | "50–60%" | ">60%";
  opll: boolean;
  t1Hypo: boolean;
  smoker: boolean;
  psychDisorder: boolean;
  gaitImpairment: boolean;
  ndi: number;
  sf36Pcs: number;
  sf36Mcs: number;
}

interface SeverityInfo {
  slug: SeveritySlug;
  label: string;
  description: string;
}

interface ApproachProbs {
  anterior: number;
  posterior: number;
  circumferential: number;
}

type UncertaintyLevel = "low" | "moderate" | "high";

interface Recommendation {
  severity: SeverityInfo;
  pSurgRule: number;
  pSurgML: number;
  pSurgCombined: number;
  surgeryRecommended: boolean;
  recommendationLabel: string;
  pMcid: number;
  riskScore: number;
  benefitScore: number;
  riskText: string;
  benefitText: string;
  approachProbs: ApproachProbs;
  bestApproach: keyof ApproachProbs | "none";
  secondBestProb: number;
  bestProb: number;
  uncertainty: UncertaintyLevel;
}

// -----------------------------
// Core clinical-ish logic
// -----------------------------

function getSeverityFromMJOA(mJOA: number): SeverityInfo {
  if (mJOA >= 15) {
    return {
      slug: "mild",
      label: "Mild (mJOA ≥ 15)",
      description: "Minimal functional limitation; typically early or mild DCM.",
    };
  }
  if (mJOA >= 12) {
    return {
      slug: "moderate",
      label: "Moderate (mJOA 12–14)",
      description:
        "Clear functional impairment; most patients are considered surgical candidates.",
    };
  }
  return {
    slug: "severe",
    label: "Severe (mJOA ≤ 11)",
    description:
      "Substantial functional compromise; guidelines strongly favor decompression.",
  };
}

function computeSurgeryProbabilities(
  p: PatientInput,
  sev: SeverityInfo
): { pRule: number; pML: number; pCombined: number; label: string } {
  const s = sev.slug;
  let pRule: number;

  // Simple, guideline-like rule:
  if (s === "severe") {
    pRule = 0.9;
  } else if (s === "moderate") {
    pRule = 0.8;
  } else {
    // mild
    const highRiskMarkers =
      p.symptomDurationMonths >= 12 ||
      p.t2Signal !== "none" ||
      p.gaitImpairment ||
      p.canalOccupying !== "<50%" ||
      p.opll;
    pRule = highRiskMarkers ? 0.7 : 0.25;
  }

  // Adjust for duration, cord signal, and gait
  if (p.symptomDurationMonths > 24) pRule += 0.05;
  if (p.t2Signal === "multilevel") pRule += 0.05;
  if (p.gaitImpairment) pRule += 0.05;

  pRule = Math.min(0.97, Math.max(0.03, pRule));

  // Prototype "ML" probability – here we keep it close to the rule and let it
  // slightly dampen extremes based on age and comorbidity.
  let pML = pRule;
  if (p.age > 75) pML -= 0.05;
  if (p.psychDisorder) pML -= 0.02;
  if (p.sf36Pcs < 30) pML -= 0.03;
  pML = Math.min(0.97, Math.max(0.03, pML));

  const pCombined = 0.5 * pRule + 0.5 * pML;

  let label: string;
  if (pCombined >= 0.75) {
    label = "Surgery recommended";
  } else if (pCombined >= 0.45) {
    label = "Consider surgery / surgery likely beneficial";
  } else {
    label = "Non-operative trial reasonable with close follow-up";
  }

  return { pRule, pML, pCombined, label };
}

function computeRiskBenefit(
  p: PatientInput,
  sev: SeverityInfo,
  pSurgCombined: number
): { pMcid: number; riskScore: number; benefitScore: number; riskText: string; benefitText: string } {
  // Prototype MCID probability – higher in mild/moderate, attenuated in severe
  let pMcid: number;
  if (sev.slug === "mild") pMcid = 0.8;
  else if (sev.slug === "moderate") pMcid = 0.6;
  else pMcid = 0.4;

  if (p.symptomDurationMonths > 24) pMcid -= 0.1;
  if (p.age > 75) pMcid -= 0.05;
  if (p.opll) pMcid -= 0.05;
  if (p.sf36Pcs < 30) pMcid -= 0.05;

  pMcid = Math.min(0.95, Math.max(0.05, pMcid));

  const riskScore = Math.round(pSurgCombined * 100);
  const benefitScore = Math.round(pMcid * 100);

  let riskText: string;
  if (sev.slug === "severe") {
    riskText =
      "Higher baseline neurological risk without decompression, especially in severe DCM. This reflects progression data from natural-history and guideline cohorts.";
  } else if (sev.slug === "moderate") {
    riskText =
      "Moderate DCM with meaningful risk of neurologic progression or failure to improve if left untreated.";
  } else {
    riskText =
      "Mild DCM with non-trivial long-term risk of neurologic progression, particularly if symptoms persist or imaging changes evolve.";
  }

  const benefitText =
    "Estimated probability of achieving clinically meaningful improvement in mJOA based on severity, duration, MRI surrogates, and comorbidity patterns.";

  return { pMcid, riskScore, benefitScore, riskText, benefitText };
}

function computeApproachProbs(
  p: PatientInput,
  sev: SeverityInfo
): { probs: ApproachProbs; best: keyof ApproachProbs | "none"; bestProb: number; secondBest: number; uncertainty: UncertaintyLevel } {
  // Start with a fairly neutral prior
  let a = 0.35;
  let post = 0.5;
  let c = 0.15;

  // Multilevel / extensive disease → posterior favored
  if (p.plannedLevels >= 3 || p.t2Signal === "multilevel") {
    post += 0.15;
    a -= 0.1;
  }

  // Marked canal compromise / OPLL → circumferential consideration
  if (p.canalOccupying === ">60%" || p.opll) {
    c += 0.1;
    post -= 0.05;
  }

  // Very focal, 1–2 level disease → anterior favored
  if (p.plannedLevels <= 2 && p.t2Signal === "focal" && !p.opll) {
    a += 0.1;
    post -= 0.1;
  }

  // Mild DCM: keep extremes in check
  if (sev.slug === "mild") {
    a += 0.02;
    post -= 0.02;
  }

  // Normalize
  const sum = a + post + c || 1;
  let probs: ApproachProbs = {
    anterior: a / sum,
    posterior: post / sum,
    circumferential: c / sum,
  };

  // "ML" adjustment – for now similar to rule but slightly upweights posterior
  // for multilevel disease and circumferential for OPLL/high canal compromise.
  let mlA = probs.anterior;
  let mlP = probs.posterior;
  let mlC = probs.circumferential;

  if (p.plannedLevels >= 3 || p.t2Signal === "multilevel") {
    mlP += 0.05;
    mlA -= 0.02;
  }
  if (p.canalOccupying === ">60%" || p.opll) {
    mlC += 0.05;
    mlP -= 0.02;
  }

  const mlSum = mlA + mlP + mlC || 1;
  mlA /= mlSum;
  mlP /= mlSum;
  mlC /= mlSum;

  // Blend rule + "ML"
  probs = {
    anterior: (probs.anterior + mlA) / 2,
    posterior: (probs.posterior + mlP) / 2,
    circumferential: (probs.circumferential + mlC) / 2,
  };

  // Determine best and uncertainty
  const entries = Object.entries(probs) as [keyof ApproachProbs, number][];
  entries.sort(([, p1], [, p2]) => p2 - p1);
  const [bestEntry, secondEntry] = entries;
  const bestKey = bestEntry?.[0] ?? "posterior";
  const bestProb = bestEntry?.[1] ?? 0;
  const secondProb = secondEntry?.[1] ?? 0;

  const gap = bestProb - secondProb;
  let uncertainty: UncertaintyLevel;
  if (gap < 0.1) uncertainty = "high";
  else if (gap < 0.25) uncertainty = "moderate";
  else uncertainty = "low";

  return {
    probs,
    best: bestProb > 0 ? bestKey : "none",
    bestProb,
    secondBest: secondProb,
    uncertainty,
  };
}

function formatPercent(p: number): string {
  return `${Math.round(p * 100)}%`;
}

// -----------------------------
// React component
// -----------------------------

type Mode = "single" | "batch";

export default function PrototypePage() {
  const [mode, setMode] = useState<Mode>("single");

  // Single-patient form state
  const [form, setForm] = useState({
    age: 65,
    sex: "M" as "M" | "F",
    mJOA: 13,
    symptomDurationMonths: 12,
    t2Signal: "multilevel" as "none" | "focal" | "multilevel",
    plannedLevels: 3,
    canalOccupying: "50–60%" as "<50%" | "50–60%" | ">60%",
    opll: "No",
    t1Hypo: "No",
    smoker: "No",
    psychDisorder: "No",
    gaitImpairment: "Yes",
    ndi: 40,
    sf36Pcs: 32,
    sf36Mcs: 45,
  });

  const [singleResult, setSingleResult] = useState<Recommendation | null>(null);

  // Batch state
  const [batchResults, setBatchResults] = useState<
    (Recommendation & { id: number })[]
  >([]);
  const [batchStatus, setBatchStatus] = useState<
    "idle" | "processing" | "done" | "error"
  >("idle");
  const [batchError, setBatchError] = useState<string | null>(null);

  // Derived severity for display
  const severityInfo = useMemo(
    () => getSeverityFromMJOA(form.mJOA),
    [form.mJOA]
  );

  function updateForm<K extends keyof typeof form>(
    key: K,
    value: (typeof form)[K]
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // Main engine call
  function runSingleRecommendation() {
    const input: PatientInput = {
      age: Number(form.age),
      sex: form.sex,
      mJOA: Number(form.mJOA),
      symptomDurationMonths: Number(form.symptomDurationMonths),
      t2Signal: form.t2Signal,
      plannedLevels: Number(form.plannedLevels),
      canalOccupying: form.canalOccupying,
      opll: form.opll === "Yes",
      t1Hypo: form.t1Hypo === "Yes",
      smoker: form.smoker === "Yes",
      psychDisorder: form.psychDisorder === "Yes",
      gaitImpairment: form.gaitImpairment === "Yes",
      ndi: Number(form.ndi),
      sf36Pcs: Number(form.sf36Pcs),
      sf36Mcs: Number(form.sf36Mcs),
    };

    const sev = getSeverityFromMJOA(input.mJOA);
    const surg = computeSurgeryProbabilities(input, sev);
    const rb = computeRiskBenefit(input, sev, surg.pCombined);
    const ap = computeApproachProbs(input, sev);

    const rec: Recommendation = {
      severity: sev,
      pSurgRule: surg.pRule,
      pSurgML: surg.pML,
      pSurgCombined: surg.pCombined,
      surgeryRecommended: surg.pCombined >= 0.45,
      recommendationLabel: surg.label,
      pMcid: rb.pMcid,
      riskScore: rb.riskScore,
      benefitScore: rb.benefitScore,
      riskText: rb.riskText,
      benefitText: rb.benefitText,
      approachProbs: ap.probs,
      bestApproach: ap.best,
      bestProb: ap.bestProb,
      secondBestProb: ap.secondBest,
      uncertainty: ap.uncertainty,
    };

    setSingleResult(rec);
  }

  // Simple CSV parser for batch mode
  function handleBatchFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setBatchStatus("processing");
    setBatchError(null);
    setBatchResults([]);

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const lines = text.trim().split(/\r?\n/);
        if (lines.length < 2) {
          throw new Error("CSV appears to be empty.");
        }

        const headers = lines[0].split(",").map((h) => h.trim());
        const results: (Recommendation & { id: number })[] = [];

        for (let i = 1; i < lines.length; i++) {
          const raw = lines[i].trim();
          if (!raw) continue;
          const cols = raw.split(",");
          const row: Record<string, string> = {};
          headers.forEach((h, idx) => {
            row[h] = (cols[idx] ?? "").trim();
          });

          const input: PatientInput = {
            age: Number(row.age ?? row.Age ?? 0),
            sex: (row.sex ?? row.Sex ?? "M") as "M" | "F",
            mJOA: Number(row.mJOA ?? row.baseline_mJOA ?? 13),
            symptomDurationMonths: Number(
              row.symptom_duration_months ??
                row.symptomDurationMonths ??
                12
            ),
            t2Signal: (row.T2_signal ??
              row.t2Signal ??
              "none") as "none" | "focal" | "multilevel",
            plannedLevels: Number(
              row.levels_operated ?? row.plannedLevels ?? 1
            ),
            canalOccupying: (row.canal_occupying_ratio_cat ??
              row.canalOccupying ??
              "<50%") as "<50%" | "50–60%" | ">60%",
            opll: (row.OPLL ?? row.opll ?? "0") === "1",
            t1Hypo: (row.T1_hypointensity ?? row.t1Hypo ?? "0") === "1",
            smoker: (row.smoker ?? "0") === "1",
            psychDisorder:
              (row.psych_disorder ?? row.psychDisorder ?? "0") === "1",
            gaitImpairment:
              (row.gait_impairment ?? row.gaitImpairment ?? "0") === "1",
            ndi: Number(row.baseline_NDI ?? row.ndi ?? 40),
            sf36Pcs: Number(row.baseline_SF36_PCS ?? row.sf36Pcs ?? 40),
            sf36Mcs: Number(row.baseline_SF36_MCS ?? row.sf36Mcs ?? 45),
          };

          const sev = getSeverityFromMJOA(input.mJOA);
          const surg = computeSurgeryProbabilities(input, sev);
          const rb = computeRiskBenefit(input, sev, surg.pCombined);
          const ap = computeApproachProbs(input, sev);
          results.push({
            id: i,
            severity: sev,
            pSurgRule: surg.pRule,
            pSurgML: surg.pML,
            pSurgCombined: surg.pCombined,
            surgeryRecommended: surg.pCombined >= 0.45,
            recommendationLabel: surg.label,
            pMcid: rb.pMcid,
            riskScore: rb.riskScore,
            benefitScore: rb.benefitScore,
            riskText: rb.riskText,
            benefitText: rb.benefitText,
            approachProbs: ap.probs,
            bestApproach: ap.best,
            bestProb: ap.bestProb,
            secondBestProb: ap.secondBest,
            uncertainty: ap.uncertainty,
          });
        }

        setBatchResults(results);
        setBatchStatus("done");
      } catch (err: any) {
        setBatchStatus("error");
        setBatchError(err?.message || "Unable to parse CSV.");
      }
    };
    reader.onerror = () => {
      setBatchStatus("error");
      setBatchError("Failed to read file.");
    };
    reader.readAsText(file);
  }

  const batchSummary = useMemo(() => {
    if (!batchResults.length) return null;

    const n = batchResults.length;
    const nSurg = batchResults.filter((r) => r.surgeryRecommended).length;
    const nNonOp = n - nSurg;

    const approachCounts: Record<string, number> = {
      anterior: 0,
      posterior: 0,
      circumferential: 0,
      none: 0,
    };
    batchResults.forEach((r) => {
      approachCounts[r.bestApproach] =
        (approachCounts[r.bestApproach] ?? 0) + 1;
    });

    return {
      n,
      nSurg,
      nNonOp,
      approachCounts,
    };
  }, [batchResults]);

  // -----------------------------
  // Render
  // -----------------------------

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      {/* Header with logo + clinic name */}
      <header className="w-full border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-center px-6 py-5">
          <Image
            src="/ascension-seton-logo.png"
            alt="Ascension Seton"
            width={240}
            height={56}
            priority
            className="h-11 w-auto"
          />
          <h1 className="mt-2 text-center text-2xl font-semibold tracking-tight">
            Ascension Texas Spine and Scoliosis
          </h1>
          <p className="mt-1 text-center text-xs text-slate-500">
            Degenerative Cervical Myelopathy Decision-Support Tool
          </p>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 pb-16 pt-6">
        {/* Back link */}
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to overview
          </Link>
          <p className="text-xs font-medium text-slate-500">
            Ascension Texas Spine and Scoliosis
          </p>
        </div>

        {/* Title + mode toggle */}
        <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-100 md:p-7">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-emerald-900">
                DCM Surgical Decision-Support
              </h2>
              <p className="mt-1 text-xs text-slate-500 md:text-sm">
                Single-patient and batch views using guideline-informed logic
                blended with prototype machine-learning patterns derived from
                synthetic DCM outcome data.
              </p>
            </div>

            <div className="inline-flex rounded-full bg-slate-100 p-1 text-xs font-medium">
              <button
                type="button"
                onClick={() => setMode("single")}
                className={`rounded-full px-4 py-1.5 ${
                  mode === "single"
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-slate-600 hover:text-slate-800"
                }`}
              >
                Single patient
              </button>
              <button
                type="button"
                onClick={() => setMode("batch")}
                className={`rounded-full px-4 py-1.5 ${
                  mode === "batch"
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-slate-600 hover:text-slate-800"
                }`}
              >
                Batch (CSV)
              </button>
            </div>
          </div>

          {/* SINGLE PATIENT MODE */}
          {mode === "single" && (
            <>
              {/* Baseline form */}
              <div className="mt-6 rounded-2xl bg-slate-50/70 p-4 ring-1 ring-slate-100 md:p-5">
                <h3 className="text-sm font-semibold text-slate-800">
                  Baseline clinical information
                </h3>

                <div className="mt-4 grid gap-4 text-xs md:grid-cols-4 md:text-sm">
                  {/* Age */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Age (years)
                    </label>
                    <input
                      type="number"
                      value={form.age}
                      onChange={(e) =>
                        updateForm("age", Number(e.target.value) || 0)
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    />
                  </div>

                  {/* Sex */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Sex
                    </label>
                    <select
                      value={form.sex}
                      onChange={(e) =>
                        updateForm("sex", e.target.value as "M" | "F")
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    >
                      <option value="M">M</option>
                      <option value="F">F</option>
                    </select>
                  </div>

                  {/* mJOA */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      mJOA
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      value={form.mJOA}
                      onChange={(e) =>
                        updateForm("mJOA", Number(e.target.value) || 0)
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    />
                  </div>

                  {/* Severity auto */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Severity (auto from mJOA)
                    </label>
                    <div className="w-full rounded-lg border border-dashed border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 md:text-sm">
                      {severityInfo.label}
                    </div>
                  </div>

                  {/* Symptom duration */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Symptom duration (months)
                    </label>
                    <input
                      type="number"
                      value={form.symptomDurationMonths}
                      onChange={(e) =>
                        updateForm(
                          "symptomDurationMonths",
                          Number(e.target.value) || 0
                        )
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    />
                  </div>

                  {/* T2 cord signal */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      T2 cord signal
                    </label>
                    <select
                      value={form.t2Signal}
                      onChange={(e) =>
                        updateForm(
                          "t2Signal",
                          e.target.value as "none" | "focal" | "multilevel"
                        )
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    >
                      <option value="none">None</option>
                      <option value="focal">Focal</option>
                      <option value="multilevel">Multilevel / extensive</option>
                    </select>
                  </div>

                  {/* Planned levels */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Planned operated levels
                    </label>
                    <input
                      type="number"
                      value={form.plannedLevels}
                      onChange={(e) =>
                        updateForm("plannedLevels", Number(e.target.value) || 1)
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    />
                  </div>

                  {/* Canal occupying */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Canal occupying ratio
                    </label>
                    <select
                      value={form.canalOccupying}
                      onChange={(e) =>
                        updateForm(
                          "canalOccupying",
                          e.target.value as "<50%" | "50–60%" | ">60%"
                        )
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    >
                      <option value="<50%">&lt;50%</option>
                      <option value="50–60%">50–60%</option>
                      <option value=">60%">&gt;60%</option>
                    </select>
                  </div>

                  {/* OPLL */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      OPLL present
                    </label>
                    <select
                      value={form.opll}
                      onChange={(e) => updateForm("opll", e.target.value)}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    >
                      <option>No</option>
                      <option>Yes</option>
                    </select>
                  </div>

                  {/* T1 hypo */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      T1 hypointensity
                    </label>
                    <select
                      value={form.t1Hypo}
                      onChange={(e) => updateForm("t1Hypo", e.target.value)}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    >
                      <option>No</option>
                      <option>Yes</option>
                    </select>
                  </div>

                  {/* Smoker */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Smoker
                    </label>
                    <select
                      value={form.smoker}
                      onChange={(e) => updateForm("smoker", e.target.value)}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    >
                      <option>No</option>
                      <option>Yes</option>
                    </select>
                  </div>

                  {/* Psych disorder */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Psychiatric disorder
                    </label>
                    <select
                      value={form.psychDisorder}
                      onChange={(e) =>
                        updateForm("psychDisorder", e.target.value)
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    >
                      <option>No</option>
                      <option>Yes</option>
                    </select>
                  </div>

                  {/* Gait impairment */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Gait impairment
                    </label>
                    <select
                      value={form.gaitImpairment}
                      onChange={(e) =>
                        updateForm("gaitImpairment", e.target.value)
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    >
                      <option>No</option>
                      <option>Yes</option>
                    </select>
                  </div>

                  {/* Baseline NDI */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      Baseline NDI
                    </label>
                    <input
                      type="number"
                      value={form.ndi}
                      onChange={(e) =>
                        updateForm("ndi", Number(e.target.value) || 0)
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    />
                  </div>

                  {/* SF-36 PCS */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      SF-36 PCS
                    </label>
                    <input
                      type="number"
                      value={form.sf36Pcs}
                      onChange={(e) =>
                        updateForm("sf36Pcs", Number(e.target.value) || 0)
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    />
                  </div>

                  {/* SF-36 MCS */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-600">
                      SF-36 MCS
                    </label>
                    <input
                      type="number"
                      value={form.sf36Mcs}
                      onChange={(e) =>
                        updateForm("sf36Mcs", Number(e.target.value) || 0)
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs md:text-sm"
                    />
                  </div>
                </div>

                <div className="mt-4 flex justify-start">
                  <button
                    type="button"
                    onClick={runSingleRecommendation}
                    className="inline-flex items-center rounded-full bg-emerald-600 px-5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                  >
                    Run recommendation
                  </button>
                </div>
              </div>

              {/* RESULTS */}
              {singleResult && (
                <div className="mt-6 space-y-5">
                  {/* SECTION 1 – SURGERY? */}
                  <section className="rounded-3xl border border-emerald-100 bg-emerald-50/60 p-5 shadow-sm md:p-6">
                    <h3 className="text-2xl font-semibold tracking-tight text-emerald-900 md:text-3xl">
                      1. Should this patient undergo surgery?
                    </h3>

                    <div className="mt-3 grid gap-5 md:grid-cols-[minmax(0,2fr),minmax(0,2fr)]">
                      <div className="space-y-2 text-xs md:text-sm">
                        <p className="text-sm font-semibold text-slate-800">
                          Recommendation:{" "}
                          <span
                            className={
                              singleResult.surgeryRecommended
                                ? "text-emerald-700"
                                : "text-amber-700"
                            }
                          >
                            {singleResult.recommendationLabel}
                          </span>
                        </p>
                        <p className="text-xs text-slate-600 md:text-sm">
                          Age {form.age}, {form.sex}, mJOA{" "}
                          {form.mJOA.toFixed(1)} ({severityInfo.slug}), symptom
                          duration ≈ {form.symptomDurationMonths.toFixed(1)}{" "}
                          months, planned levels {form.plannedLevels}. Gait
                          impairment: {form.gaitImpairment}. OPLL: {form.opll}.
                          Canal compromise: {form.canalOccupying}. T2 cord
                          signal: {form.t2Signal}.
                        </p>
                        <p className="text-xs text-slate-600 md:text-sm">
                          <span className="font-semibold">Risk vs benefit snapshot</span>
                          <br />
                          <span className="font-semibold">
                            Risk without surgery:
                          </span>{" "}
                          {singleResult.riskScore}% estimated chance of
                          neurological worsening or failure to improve.
                          <br />
                          <span className="font-semibold">
                            Expected benefit with surgery:
                          </span>{" "}
                          {singleResult.benefitScore}% estimated chance of
                          clinically meaningful mJOA improvement.
                        </p>
                        <p className="text-xs text-slate-600 md:text-xs">
                          {singleResult.riskText}
                        </p>
                      </div>

                      {/* Risk vs benefit dials */}
                      <div className="space-y-4">
                        <div>
                          <p className="text-xs font-medium text-slate-700">
                            Risk of neurological worsening without surgery
                          </p>
                          <div className="mt-1 flex items-center gap-3">
                            <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-rose-100">
                              <div
                                className="absolute inset-y-0 left-0 rounded-full bg-rose-500"
                                style={{
                                  width: `${singleResult.riskScore}%`,
                                }}
                              />
                            </div>
                            <span className="w-12 text-right text-xs font-semibold text-rose-700">
                              {singleResult.riskScore}%
                            </span>
                          </div>
                        </div>

                        <div>
                          <p className="text-xs font-medium text-slate-700">
                            Expected chance of meaningful improvement with
                            surgery
                          </p>
                          <div className="mt-1 flex items-center gap-3">
                            <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-emerald-100">
                              <div
                                className="absolute inset-y-0 left-0 rounded-full bg-emerald-500"
                                style={{
                                  width: `${singleResult.benefitScore}%`,
                                }}
                              />
                            </div>
                            <span className="w-12 text-right text-xs font-semibold text-emerald-700">
                              {singleResult.benefitScore}%
                            </span>
                          </div>
                        </div>

                        <p className="text-[11px] text-slate-500">
                          Values are approximate and intended for discussion
                          alongside surgeon judgment, patient values, and
                          detailed imaging review.
                        </p>
                      </div>
                    </div>
                  </section>

                  {/* SECTION 2 – APPROACH */}
                  <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-100 md:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="text-lg font-semibold text-slate-900 md:text-xl">
                        2. If surgery is offered, which approach?
                      </h3>
                      <div className="flex items-center gap-2 text-[11px] md:text-xs">
                        <span className="font-medium text-slate-600">
                          Uncertainty:
                        </span>
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                            singleResult.uncertainty === "low"
                              ? "bg-emerald-50 text-emerald-700"
                              : singleResult.uncertainty === "moderate"
                              ? "bg-amber-50 text-amber-700"
                              : "bg-rose-50 text-rose-700"
                          }`}
                        >
                          {singleResult.uncertainty.charAt(0).toUpperCase() +
                            singleResult.uncertainty.slice(1)}
                        </span>
                      </div>
                    </div>

                    <p className="mt-1 text-[11px] text-slate-500 md:text-xs">
                      Uncertainty reflects how close the modeled probabilities
                      are between approaches:{" "}
                      <span className="font-medium">
                        high uncertainty means the approaches have similar
                        probabilities
                      </span>{" "}
                      and anatomy, alignment, and surgeon experience should
                      strongly influence the final decision.
                    </p>

                    {/* Approach cards */}
                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      {(["anterior", "posterior", "circumferential"] as const).map(
                        (key) => {
                          const prob = singleResult.approachProbs[key];
                          const isBest =
                            singleResult.bestApproach === key &&
                            singleResult.bestApproach !== "none";
                          const label =
                            key === "anterior"
                              ? "ANTERIOR"
                              : key === "posterior"
                              ? "POSTERIOR"
                              : "CIRCUMFERENTIAL";

                          const accent =
                            key === "posterior"
                              ? "border-emerald-500 bg-emerald-50/70"
                              : "border-slate-200 bg-slate-50/60";

                          return (
                            <div
                              key={key}
                              className={`rounded-2xl border p-3 text-xs md:text-sm ${accent}`}
                            >
                              <div className="flex items-baseline justify-between gap-2">
                                <p className="text-[11px] font-semibold tracking-wide text-slate-700">
                                  {label}
                                </p>
                                <p className="text-sm font-semibold text-slate-900 md:text-base">
                                  {formatPercent(prob)}
                                </p>
                              </div>
                              <p className="mt-1 text-[11px] text-slate-600 md:text-xs">
                                {isBest
                                  ? "Highest estimated chance of clinically meaningful mJOA improvement."
                                  : "Lower modeled probability compared with the leading approach."}
                              </p>
                            </div>
                          );
                        }
                      )}
                    </div>

                    {/* Confidence bands */}
                    <div className="mt-5 space-y-2 text-xs">
                      <p className="text-[11px] font-medium text-slate-700">
                        P(MCID) by approach (approximate confidence bands)
                      </p>
                      {(["anterior", "posterior", "circumferential"] as const).map(
                        (key) => {
                          const prob = singleResult.approachProbs[key];
                          const center = prob * 100;
                          const low = Math.max(0, Math.round(center - 10));
                          const high = Math.min(100, Math.round(center + 10));

                          return (
                            <div
                              key={key}
                              className="flex items-center gap-3 text-[11px] md:text-xs"
                            >
                              <div className="w-20 font-medium capitalize text-slate-700">
                                {key}
                              </div>
                              <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                                <div
                                  className="absolute inset-y-0 left-0 rounded-full bg-slate-400"
                                  style={{ width: `${high}%` }}
                                />
                                <div
                                  className="absolute inset-y-0 left-0 rounded-full bg-slate-700"
                                  style={{ width: `${center}%` }}
                                />
                              </div>
                              <div className="w-28 text-right text-[11px] text-slate-600">
                                {center.toFixed(0)}% (≈ {low}–{high}%)
                              </div>
                            </div>
                          );
                        }
                      )}
                      <p className="mt-2 text-[11px] text-slate-500">
                        Patterns combine literature-based preferences (e.g.,
                        multilevel disease, kyphosis, OPLL) with prototype
                        model estimates derived from synthetic DCM outcome
                        data.
                      </p>
                    </div>

                    {/* Download / print summary */}
                    <div className="mt-5 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => window.print()}
                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                      >
                        <FileDown className="h-3.5 w-3.5" />
                        Download / print summary (PDF)
                      </button>
                      <p className="text-[11px] text-slate-500">
                        Uses the browser’s print-to-PDF function to create a
                        one-page summary of the current patient inputs and
                        recommendations.
                      </p>
                    </div>
                  </section>
                </div>
              )}
            </>
          )}

          {/* BATCH MODE */}
          {mode === "batch" && (
            <div className="mt-6 space-y-5">
              <section className="rounded-3xl bg-slate-50/70 p-4 ring-1 ring-slate-100 md:p-5">
                <h3 className="text-sm font-semibold text-slate-800">
                  Batch mode (CSV upload)
                </h3>
                <p className="mt-1 text-[11px] text-slate-600 md:text-xs">
                  Upload a CSV file where each row represents one patient. The
                  file should include the following columns (header row{" "}
                  <span className="font-semibold">required</span>):{" "}
                  <code className="rounded bg-slate-200 px-1 py-0.5 text-[10px]">
                    age, sex, smoker, symptom_duration_months, severity,
                    baseline_mJOA, levels_operated, OPLL,
                    canal_occupying_ratio_cat, T2_signal, T1_hypointensity,
                    gait_impairment, psych_disorder, baseline_NDI,
                    baseline_SF36_PCS, baseline_SF36_MCS
                  </code>
                  . Values mirror the single-patient form.
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-4">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-dashed border-slate-300 bg-white px-4 py-1.5 text-xs font-medium text-slate-700 hover:border-emerald-400">
                    <Upload className="h-3.5 w-3.5" />
                    <span>Select CSV file</span>
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={handleBatchFile}
                    />
                  </label>
                  {batchStatus === "processing" && (
                    <p className="text-[11px] text-slate-500">
                      Processing file…
                    </p>
                  )}
                  {batchStatus === "error" && batchError && (
                    <p className="text-[11px] text-rose-600">
                      {batchError}
                    </p>
                  )}
                </div>
              </section>

              {batchSummary && (
                <section className="space-y-4 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-100 md:p-6">
                  <h3 className="text-sm font-semibold text-slate-900 md:text-base">
                    Batch summary
                  </h3>
                  <div className="grid gap-4 text-xs md:grid-cols-4 md:text-sm">
                    <div className="rounded-2xl bg-slate-50 p-3">
                      <p className="text-[11px] text-slate-500">
                        Total patients
                      </p>
                      <p className="mt-1 text-xl font-semibold">
                        {batchSummary.n}
                      </p>
                    </div>
                    <div className="rounded-2xl bg-emerald-50 p-3">
                      <p className="text-[11px] text-emerald-700">
                        Surgery recommended
                      </p>
                      <p className="mt-1 text-xl font-semibold text-emerald-800">
                        {batchSummary.nSurg}{" "}
                        <span className="text-xs font-medium text-emerald-700">
                          (
                          {Math.round(
                            (batchSummary.nSurg / batchSummary.n) * 100
                          )}
                          %)
                        </span>
                      </p>
                    </div>
                    <div className="rounded-2xl bg-amber-50 p-3">
                      <p className="text-[11px] text-amber-700">
                        Non-operative trial reasonable
                      </p>
                      <p className="mt-1 text-xl font-semibold text-amber-800">
                        {batchSummary.nNonOp}
                      </p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-3">
                      <p className="text-[11px] text-slate-500">
                        Leading approach distribution
                      </p>
                      <p className="mt-1 text-xs text-slate-700">
                        Anterior:{" "}
                        {Math.round(
                          ((batchSummary.approachCounts.anterior || 0) /
                            batchSummary.n) *
                            100
                        )}
                        %
                        <br />
                        Posterior:{" "}
                        {Math.round(
                          ((batchSummary.approachCounts.posterior || 0) /
                            batchSummary.n) *
                            100
                        )}
                        %
                        <br />
                        Circumferential:{" "}
                        {Math.round(
                          ((batchSummary.approachCounts.circumferential || 0) /
                            batchSummary.n) *
                            100
                        )}
                        %
                      </p>
                    </div>
                  </div>

                  {/* Table */}
                  <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-100">
                    <table className="min-w-full divide-y divide-slate-100 text-[11px] md:text-xs">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium text-slate-600">
                            #
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-slate-600">
                            Severity
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-slate-600">
                            Recommendation
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-slate-600">
                            Risk
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-slate-600">
                            Benefit
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-slate-600">
                            Best approach
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-slate-600">
                            Uncertainty
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 bg-white">
                        {batchResults.slice(0, 50).map((r) => (
                          <tr key={r.id}>
                            <td className="px-3 py-1.5 text-slate-500">
                              {r.id}
                            </td>
                            <td className="px-3 py-1.5 text-slate-700">
                              {r.severity.slug}
                            </td>
                            <td className="px-3 py-1.5 text-slate-700">
                              {r.recommendationLabel}
                            </td>
                            <td className="px-3 py-1.5 text-slate-700">
                              {r.riskScore}%
                            </td>
                            <td className="px-3 py-1.5 text-slate-700">
                              {r.benefitScore}%
                            </td>
                            <td className="px-3 py-1.5 text-slate-700">
                              {r.bestApproach}
                            </td>
                            <td className="px-3 py-1.5 text-slate-700">
                              {r.uncertainty}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Table shows up to the first 50 rows for quick review; export
                    from your analytics environment if you need full cohort-
                    level summaries.
                  </p>
                </section>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
