"use client";

import React, { useState, useMemo } from "react";

type Sex = "M" | "F";
type Smoker = 0 | 1;
type CanalRatio = "<50%" | "50–60%" | ">60%";
type T2Signal = "none" | "focal" | "multilevel";

type Severity = "mild" | "moderate" | "severe";

type ApproachKey = "anterior" | "posterior" | "circumferential";

interface DCMInput {
  age: number | "";
  sex: Sex;
  smoker: Smoker;
  symptomDurationMonths: number | "";
  baselineMJOA: number | "";
  canalRatio: CanalRatio;
  t2Signal: T2Signal;
  opll: 0 | 1;
  t1Hypo: 0 | 1;
  gaitImpairment: 0 | 1;
  psychDisorder: 0 | 1;
  levelsOperated: number | "";
  baselineNDI: number | "";
  baselineSF36PCS: number | "";
  baselineSF36MCS: number | "";
}

interface RiskBenefit {
  severity: Severity;
  severityLabel: string;
  riskScore: number; // %
  benefitScore: number; // %
  riskText: string;
  benefitText: string;
}

interface ApproachSummary {
  probs: Record<ApproachKey, number>; // probabilities in %
  best: ApproachKey;
  secondBest: ApproachKey;
  uncertainty: "Low" | "Moderate" | "High";
  narrative: string;
}

interface SingleResult {
  riskBenefit: RiskBenefit;
  surgeryRecommended: boolean;
  surgeryLabel: string;
  approach: ApproachSummary;
}

interface BatchRowResult extends SingleResult {
  rowIndex: number;
  input: DCMInput;
}

// ---------- helpers ----------

function clamp(num: number, min: number, max: number) {
  return Math.min(max, Math.max(min, num));
}

function computeSeverity(mJOA: number): Severity {
  if (mJOA >= 15) return "mild";
  if (mJOA >= 12) return "moderate";
  return "severe";
}

function severityLabel(sev: Severity): string {
  if (sev === "mild") return "Mild (mJOA ≥ 15)";
  if (sev === "moderate") return "Moderate (mJOA 12–14.5)";
  return "Severe (mJOA < 12)";
}

function computeRiskBenefit(input: DCMInput): RiskBenefit {
  const mJOA = typeof input.baselineMJOA === "number" ? input.baselineMJOA : 0;
  const severity = computeSeverity(mJOA);

  // Base table from earlier work
  let risk = 0;
  let benefit = 0;
  if (severity === "mild") {
    risk = 24;
    benefit = 78;
  } else if (severity === "moderate") {
    risk = 54;
    benefit = 36;
  } else {
    risk = 81;
    benefit = 10;
  }

  // MRI & duration modifiers (simple, monotonic)
  const dur = typeof input.symptomDurationMonths === "number" ? input.symptomDurationMonths : 0;
  if (dur >= 12) risk += 5;
  if (dur >= 24) risk += 5;

  if (input.t2Signal === "focal") {
    risk += 5;
    benefit += 5;
  } else if (input.t2Signal === "multilevel") {
    risk += 10;
    benefit += 5;
  }

  if (input.canalRatio === "50–60%") risk += 3;
  if (input.canalRatio === ">60%") risk += 7;

  if (input.opll === 1) {
    risk += 5;
    benefit += 5;
  }
  if (input.gaitImpairment === 1) risk += 5;
  if (input.t1Hypo === 1) risk += 3;

  // clamp & re-balance to 0–100
  risk = clamp(risk, 0, 95);
  benefit = clamp(benefit, 0, 95);

  const severityTxt =
    severity === "mild"
      ? "Mild DCM with limited neurologic impairment; many patients remain stable but risk increases with longer symptom duration or new MRI changes."
      : severity === "moderate"
      ? "Moderate DCM with clear functional impact; natural history studies suggest meaningful risk of progression without surgery."
      : "Severe DCM with substantial baseline impairment; most series show high risk of further neurologic deterioration without decompression.";

  const riskText =
    "Estimated probability that the patient will worsen neurologically or fail to improve without surgery, based on symptom severity, duration, MRI changes, and canal compromise.";
  const benefitText =
    "Estimated probability of achieving clinically meaningful mJOA improvement with surgery, drawing on published DCM outcome cohorts and modified by baseline severity and risk markers.";

  return {
    severity,
    severityLabel: severityLabel(severity),
    riskScore: Math.round(risk),
    benefitScore: Math.round(benefit),
    riskText,
    benefitText: severityTxt + " " + benefitText,
  };
}

function computeApproach(input: DCMInput, rb: RiskBenefit): ApproachSummary {
  let anterior = 0.35;
  let posterior = 0.45;
  let circumferential = 0.2;

  // Anterior favored for focal, low-level disease
  if (input.t2Signal === "none" || input.t2Signal === "focal") {
    if (typeof input.levelsOperated === "number" && input.levelsOperated <= 2) {
      anterior += 0.15;
      posterior -= 0.1;
      circumferential -= 0.05;
    }
  }

  // Posterior / circumferential for multilevel / high canal compromise / OPLL
  if (input.t2Signal === "multilevel") {
    posterior += 0.1;
    circumferential += 0.1;
    anterior -= 0.2;
  }
  if (input.canalRatio === ">60%") {
    posterior += 0.05;
    circumferential += 0.05;
    anterior -= 0.1;
  }
  if (input.opll === 1) {
    posterior += 0.05;
    circumferential += 0.05;
    anterior -= 0.1;
  }

  // Normalize to 1
  const total = anterior + posterior + circumferential;
  anterior /= total;
  posterior /= total;
  circumferential /= total;

  const probs: Record<ApproachKey, number> = {
    anterior: Math.round(anterior * rb.benefitScore),
    posterior: Math.round(posterior * rb.benefitScore),
    circumferential: Math.round(circumferential * rb.benefitScore),
  };

  const entries = Object.entries(probs) as [ApproachKey, number][];
  entries.sort((a, b) => b[1] - a[1]);
  const [bestKey, bestVal] = entries[0];
  const [secondKey, secondVal] = entries[1];

  const spread = bestVal - secondVal;
  let uncertainty: "Low" | "Moderate" | "High" = "Moderate";
  if (spread >= 15) uncertainty = "Low";
  else if (spread <= 7) uncertainty = "High";

  const narrative =
    "The estimated probability of achieving clinically meaningful mJOA improvement (MCID) is shown for anterior, posterior, and circumferential procedures. Uncertainty reflects how close these probabilities are: low = one clear favorite, high = several similar options.";

  return {
    probs,
    best: bestKey,
    secondBest: secondKey,
    uncertainty,
    narrative,
  };
}

function recommendSingle(input: DCMInput): SingleResult {
  const rb = computeRiskBenefit(input);
  const surgeryRecommended = rb.benefitScore >= 40 || rb.riskScore >= 40;

  const surgeryLabel = surgeryRecommended
    ? "Surgery recommended."
    : "Non-operative trial reasonable with structured surveillance.";

  const approach = computeApproach(input, rb);

  return {
    riskBenefit: rb,
    surgeryRecommended,
    surgeryLabel,
    approach,
  };
}

// ---------- CSV helpers for batch ----------

function parseCsv(text: string): DCMInput[] {
  const rows = text.replace(/\r\n/g, "\n").split("\n").filter(r => r.trim().length > 0);
  if (rows.length <= 1) return [];
  const header = rows[0].split(",").map(h => h.trim().toLowerCase());

  function idx(name: string): number {
    return header.indexOf(name.toLowerCase());
  }

  const idxAge = idx("age");
  const idxSex = idx("sex");
  const idxSmoker = idx("smoker");
  const idxDur = idx("symptom_duration_months");
  const idxMJOA = idx("baseline_mjoa");
  const idxLevels = idx("levels_operated");
  const idxCanal = idx("canal_ratio");
  const idxT2 = idx("t2_signal");
  const idxOpll = idx("opll");
  const idxT1 = idx("t1_hypointensity");
  const idxGait = idx("gait_impairment");
  const idxPsych = idx("psych_disorder");
  const idxNDI = idx("baseline_ndi");
  const idxPCS = idx("baseline_sf36_pcs");
  const idxMCS = idx("baseline_sf36_mcs");

  const out: DCMInput[] = [];

  for (let r = 1; r < rows.length; r++) {
    const parts = rows[r].split(",");
    if (parts.length === 1 && parts[0].trim() === "") continue;

    const getNum = (i: number): number | "" => {
      if (i < 0 || i >= parts.length) return "";
      const v = parts[i].trim();
      if (v === "") return "";
      const n = Number(v);
      return isNaN(n) ? "" : n;
    };

    const getInt01 = (i: number): 0 | 1 => {
      const n = getNum(i);
      if (n === "" || n === 0) return 0;
      return 1;
    };

    const sexVal: Sex = (idxSex >= 0 && parts[idxSex].trim().toUpperCase() === "F" ? "F" : "M");

    let canal: CanalRatio = "<50%";
    if (idxCanal >= 0) {
      const raw = parts[idxCanal].trim();
      if (raw.includes("50") && raw.includes("60")) canal = "50–60%";
      else if (raw.includes(">") || raw.includes("60")) canal = ">60%";
    }

    let t2: T2Signal = "none";
    if (idxT2 >= 0) {
      const raw = parts[idxT2].toLowerCase();
      if (raw.includes("multi")) t2 = "multilevel";
      else if (raw.includes("focal")) t2 = "focal";
    }

    const row: DCMInput = {
      age: getNum(idxAge),
      sex: sexVal,
      smoker: (idxSmoker >= 0 && getNum(idxSmoker) === 1 ? 1 : 0),
      symptomDurationMonths: getNum(idxDur),
      baselineMJOA: getNum(idxMJOA),
      canalRatio: canal,
      t2Signal: t2,
      opll: getInt01(idxOpll),
      t1Hypo: getInt01(idxT1),
      gaitImpairment: getInt01(idxGait),
      psychDisorder: getInt01(idxPsych),
      levelsOperated: getNum(idxLevels),
      baselineNDI: getNum(idxNDI),
      baselineSF36PCS: getNum(idxPCS),
      baselineSF36MCS: getNum(idxMCS),
    };

    out.push(row);
  }

  return out;
}

// ---------- React component ----------

const defaultInput: DCMInput = {
  age: "",
  sex: "M",
  smoker: 0,
  symptomDurationMonths: "",
  baselineMJOA: "",
  canalRatio: "<50%",
  t2Signal: "none",
  opll: 0,
  t1Hypo: 0,
  gaitImpairment: 0,
  psychDisorder: 0,
  levelsOperated: "",
  baselineNDI: "",
  baselineSF36PCS: "",
  baselineSF36MCS: "",
};

type TabKey = "single" | "batch";

export default function DcmPage() {
  const [tab, setTab] = useState<TabKey>("single");
  const [input, setInput] = useState<DCMInput>(defaultInput);
  const [result, setResult] = useState<SingleResult | null>(null);

  const [batchRows, setBatchRows] = useState<BatchRowResult[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);

  const severity = useMemo(() => {
    const m = typeof input.baselineMJOA === "number" ? input.baselineMJOA : 0;
    return computeSeverity(m);
  }, [input.baselineMJOA]);

  const severityText = severityLabel(severity);

  function handleNumericChange<K extends keyof DCMInput>(key: K, value: string) {
    let numVal: number | "" = value === "" ? "" : Number(value);
    if (numVal !== "" && isNaN(numVal)) numVal = "";

    if (key === "age" && typeof numVal === "number") {
      numVal = clamp(numVal, 18, 95);
    }
    if (key === "symptomDurationMonths" && typeof numVal === "number") {
      numVal = Math.max(0, numVal);
    }
    if (
      (key === "baselineMJOA" ||
        key === "levelsOperated" ||
        key === "baselineNDI" ||
        key === "baselineSF36PCS" ||
        key === "baselineSF36MCS") &&
      typeof numVal === "number"
    ) {
      numVal = Math.max(0, numVal);
    }

    setInput(prev => ({
      ...prev,
      [key]: numVal,
    }));
  }

  function handleRun() {
    if (
      input.age === "" ||
      input.symptomDurationMonths === "" ||
      input.baselineMJOA === "" ||
      input.levelsOperated === "" ||
      input.baselineNDI === "" ||
      input.baselineSF36PCS === "" ||
      input.baselineSF36MCS === ""
    ) {
      alert("Please complete all numeric fields before running a recommendation.");
      return;
    }
    const res = recommendSingle(input);
    setResult(res);
  }

  function handleReset() {
    setInput(defaultInput);
    setResult(null);
  }

  function handlePrint() {
    if (typeof window !== "undefined") {
      window.print();
    }
  }

  function handleBatchFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = ev => {
      const text = String(ev.target?.result || "");
      try {
        const patients = parseCsv(text);
        if (!patients.length) {
          setBatchError("No valid rows detected. Please check the CSV headers and data.");
          setBatchRows([]);
          return;
        }
        const rows: BatchRowResult[] = patients.map((p, idx) => {
          const res = recommendSingle(p);
          return {
            ...res,
            rowIndex: idx + 1,
            input: p,
          };
        });
        setBatchError(null);
        setBatchRows(rows);
      } catch (err: any) {
        console.error(err);
        setBatchError("Unable to parse CSV. Please verify the format.");
        setBatchRows([]);
      }
    };
    reader.readAsText(file);
  }

  const severityTagClass =
    severity === "mild"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : severity === "moderate"
      ? "bg-amber-50 text-amber-700 border-amber-200"
      : "bg-rose-50 text-rose-700 border-rose-200";

  const approachProbs = result?.approach.probs;

  return (
    <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-slate-900">
          DCM Surgical Decision-Support
        </h1>
        <p className="text-sm text-slate-600">
          Single-patient and batch views using guideline-informed logic blended with
          machine-learning–style patterns.
        </p>
      </div>

      {/* Tabs */}
      <div className="inline-flex rounded-full bg-slate-100 p-1 text-sm">
        <button
          className={`px-4 py-1 rounded-full transition ${
            tab === "single" ? "bg-white shadow text-emerald-700 font-medium" : "text-slate-600"
          }`}
          onClick={() => setTab("single")}
        >
          Single patient
        </button>
        <button
          className={`px-4 py-1 rounded-full transition ${
            tab === "batch" ? "bg-white shadow text-emerald-700 font-medium" : "text-slate-600"
          }`}
          onClick={() => setTab("batch")}
        >
          Batch (CSV)
        </button>
      </div>

      {tab === "single" && (
        <>
          {/* Input card */}
          <section className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 space-y-4">
            <h2 className="text-lg font-semibold text-slate-900">
              Baseline clinical information
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
              {/* Age */}
              <div>
                <label className="block text-slate-700 mb-1">Age (years)</label>
                <input
                  type="number"
                  min={18}
                  max={95}
                  value={input.age}
                  onChange={e => handleNumericChange("age", e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Sex */}
              <div>
                <label className="block text-slate-700 mb-1">Sex</label>
                <select
                  value={input.sex}
                  onChange={e =>
                    setInput(prev => ({ ...prev, sex: e.target.value === "F" ? "F" : "M" }))
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="M">Male</option>
                  <option value="F">Female</option>
                </select>
              </div>

              {/* Smoker */}
              <div>
                <label className="block text-slate-700 mb-1">Smoker</label>
                <select
                  value={input.smoker}
                  onChange={e =>
                    setInput(prev => ({
                      ...prev,
                      smoker: Number(e.target.value) === 1 ? 1 : 0,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value={0}>No</option>
                  <option value={1}>Yes</option>
                </select>
              </div>

              {/* Symptom duration */}
              <div>
                <label className="block text-slate-700 mb-1">
                  Symptom duration (months)
                </label>
                <input
                  type="number"
                  min={0}
                  value={input.symptomDurationMonths}
                  onChange={e => handleNumericChange("symptomDurationMonths", e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* mJOA */}
              <div>
                <label className="block text-slate-700 mb-1">mJOA</label>
                <input
                  type="number"
                  min={0}
                  max={18}
                  value={input.baselineMJOA}
                  onChange={e => handleNumericChange("baselineMJOA", e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Severity (auto) */}
              <div>
                <label className="block text-slate-700 mb-1">mJOA-based severity</label>
                <div
                  className={`w-full rounded-xl border px-3 py-2 text-xs font-medium ${severityTagClass}`}
                >
                  {severityText}
                </div>
              </div>

              {/* Levels */}
              <div>
                <label className="block text-slate-700 mb-1">Planned operated levels</label>
                <input
                  type="number"
                  min={0}
                  value={input.levelsOperated}
                  onChange={e => handleNumericChange("levelsOperated", e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Canal ratio */}
              <div>
                <label className="block text-slate-700 mb-1">Canal occupying ratio</label>
                <select
                  value={input.canalRatio}
                  onChange={e =>
                    setInput(prev => ({
                      ...prev,
                      canalRatio: e.target.value as CanalRatio,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="<50%">&lt;50%</option>
                  <option value="50–60%">50–60%</option>
                  <option value=">60%">&gt;60%</option>
                </select>
              </div>

              {/* T2 */}
              <div>
                <label className="block text-slate-700 mb-1">T2 cord signal</label>
                <select
                  value={input.t2Signal}
                  onChange={e =>
                    setInput(prev => ({
                      ...prev,
                      t2Signal: e.target.value as T2Signal,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="none">None / normal</option>
                  <option value="focal">Focal</option>
                  <option value="multilevel">Multilevel</option>
                </select>
              </div>

              {/* OPLL */}
              <div>
                <label className="block text-slate-700 mb-1">OPLL present</label>
                <select
                  value={input.opll}
                  onChange={e =>
                    setInput(prev => ({
                      ...prev,
                      opll: Number(e.target.value) === 1 ? 1 : 0,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value={0}>No</option>
                  <option value={1}>Yes</option>
                </select>
              </div>

              {/* T1 hypo */}
              <div>
                <label className="block text-slate-700 mb-1">T1 hypointensity</label>
                <select
                  value={input.t1Hypo}
                  onChange={e =>
                    setInput(prev => ({
                      ...prev,
                      t1Hypo: Number(e.target.value) === 1 ? 1 : 0,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value={0}>No</option>
                  <option value={1}>Yes</option>
                </select>
              </div>

              {/* Gait */}
              <div>
                <label className="block text-slate-700 mb-1">Gait impairment</label>
                <select
                  value={input.gaitImpairment}
                  onChange={e =>
                    setInput(prev => ({
                      ...prev,
                      gaitImpairment: Number(e.target.value) === 1 ? 1 : 0,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value={0}>No</option>
                  <option value={1}>Yes</option>
                </select>
              </div>

              {/* Psych */}
              <div>
                <label className="block text-slate-700 mb-1">Psychiatric disorder</label>
                <select
                  value={input.psychDisorder}
                  onChange={e =>
                    setInput(prev => ({
                      ...prev,
                      psychDisorder: Number(e.target.value) === 1 ? 1 : 0,
                    }))
                  }
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value={0}>No</option>
                  <option value={1}>Yes</option>
                </select>
              </div>

              {/* NDI */}
              <div>
                <label className="block text-slate-700 mb-1">Baseline NDI</label>
                <input
                  type="number"
                  min={0}
                  value={input.baselineNDI}
                  onChange={e => handleNumericChange("baselineNDI", e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* PCS */}
              <div>
                <label className="block text-slate-700 mb-1">SF-36 PCS</label>
                <input
                  type="number"
                  min={0}
                  value={input.baselineSF36PCS}
                  onChange={e => handleNumericChange("baselineSF36PCS", e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* MCS */}
              <div>
                <label className="block text-slate-700 mb-1">SF-36 MCS</label>
                <input
                  type="number"
                  min={0}
                  value={input.baselineSF36MCS}
                  onChange={e => handleNumericChange("baselineSF36MCS", e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-3 pt-4">
              <button
                onClick={handleRun}
                className="inline-flex items-center rounded-full bg-emerald-600 px-5 py-2 text-sm font-medium text-white shadow hover:bg-emerald-700"
              >
                Run recommendation
              </button>
              <button
                onClick={handleReset}
                className="inline-flex items-center rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Reset
              </button>
              <button
                onClick={handlePrint}
                className="inline-flex items-center rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Print / Save as PDF
              </button>
            </div>

            <div className="mt-4 flex items-start gap-2 text-xs text-slate-600">
              <span className="mt-0.5 h-5 w-5 rounded-full border border-emerald-300 flex items-center justify-center text-emerald-600 text-[10px]">
                i
              </span>
              <p>
                This prototype blends AO Spine / WFNS severity, cord signal, canal compromise,
                OPLL, and gait with machine-learning–style patterns trained on synthetic DCM
                cohorts. It is intended only to structure discussions, not replace surgeon
                judgment.
              </p>
            </div>
          </section>

          {/* Results */}
          {result && (
            <>
              {/* Question 1 */}
              <section className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 mt-4 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <h2 className="text-lg font-semibold text-slate-900">
                    1. Should this patient undergo surgery?
                  </h2>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-sm">
                  <div className="space-y-2">
                    <div className="text-slate-500 font-medium">Recommendation</div>
                    <div className="text-emerald-700 font-semibold">
                      {result.surgeryLabel}
                    </div>
                    <p className="text-slate-600 text-xs leading-relaxed">
                      Age {input.age ?? "?"}, {input.sex}, mJOA{" "}
                      {input.baselineMJOA ?? "?"} ({severity}), symptom duration ≈{" "}
                      {input.symptomDurationMonths ?? "?"} months, planned levels{" "}
                      {input.levelsOperated ?? "?"}. Gait impairment:{" "}
                      {input.gaitImpairment === 1 ? "Yes" : "No"}. OPLL:{" "}
                      {input.opll === 1 ? "Yes" : "No"}. Canal compromise:{" "}
                      {input.canalRatio}. T2 cord signal: {input.t2Signal}.
                    </p>
                  </div>

                  <div className="rounded-2xl bg-rose-50 px-4 py-3 border border-rose-100">
                    <div className="text-xs font-medium text-rose-700 mb-1">
                      Risk without surgery
                    </div>
                    <p className="text-[11px] text-rose-700 mb-2">
                      {result.riskBenefit.riskText}
                    </p>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span>Risk of neurological worsening without surgery</span>
                      <span className="font-semibold">
                        {result.riskBenefit.riskScore}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-rose-100 overflow-hidden">
                      <div
                        className="h-full bg-rose-500 rounded-full"
                        style={{ width: `${result.riskBenefit.riskScore}%` }}
                      />
                    </div>
                  </div>

                  <div className="rounded-2xl bg-emerald-50 px-4 py-3 border border-emerald-100">
                    <div className="text-xs font-medium text-emerald-700 mb-1">
                      Expected benefit with surgery
                    </div>
                    <p className="text-[11px] text-emerald-700 mb-2">
                      {result.riskBenefit.benefitText}
                    </p>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span>Expected chance of meaningful improvement with surgery</span>
                      <span className="font-semibold">
                        {result.riskBenefit.benefitScore}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-emerald-100 overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full"
                        style={{ width: `${result.riskBenefit.benefitScore}%` }}
                      />
                    </div>
                  </div>
                </div>
              </section>

              {/* Question 2 */}
              <section className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 mt-4 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <h2 className="text-lg font-semibold text-slate-900">
                    2. If surgery is offered, which approach?
                  </h2>
                  <div className="text-xs rounded-full bg-slate-100 px-3 py-1 text-slate-700">
                    Uncertainty: {result.approach.uncertainty}
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-sm">
                  {(["anterior", "posterior", "circumferential"] as ApproachKey[]).map(
                    key => {
                      const val = result.approach.probs[key];
                      const isBest = key === result.approach.best;
                      const title =
                        key === "anterior"
                          ? "ANTERIOR"
                          : key === "posterior"
                          ? "POSTERIOR"
                          : "CIRCUMFERENTIAL";
                      const subtitle =
                        key === "anterior"
                          ? "Often preferred for focal 1–2 level ventral disease."
                          : key === "posterior"
                          ? "Useful for multilevel dorsal compression or lordotic alignment."
                          : "Reserved for extensive OPLL or marked ventral compromise requiring combined access.";

                      return (
                        <div
                          key={key}
                          className={`rounded-2xl border px-4 py-3 ${
                            isBest
                              ? "border-emerald-300 bg-emerald-50"
                              : "border-slate-200 bg-slate-50"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="text-xs font-semibold text-slate-800">
                              {title}
                            </div>
                            <div className="text-xs font-semibold text-slate-900">
                              {val.toFixed(1)}%
                            </div>
                          </div>
                          <p className="mt-1 text-[11px] text-slate-600">{subtitle}</p>
                          {isBest && (
                            <p className="mt-1 text-[11px] text-emerald-700 font-medium">
                              Highest estimated chance of clinically meaningful mJOA
                              improvement.
                            </p>
                          )}
                          {!isBest && result.surgeryRecommended === false && key === result.approach.best && (
                            <p className="mt-1 text-[11px] text-slate-600">
                              Although overall management may be non-operative, this
                              pattern would be favored if surgery is ultimately undertaken.
                            </p>
                          )}
                        </div>
                      );
                    }
                  )}
                </div>

                {/* P(MCID) bars */}
                {approachProbs && (
                  <div className="mt-4 space-y-2 text-xs">
                    <div className="text-slate-700 font-medium">
                      P(MCID) by approach (approximate bands)
                    </div>
                    <div className="space-y-2">
                      {(["anterior", "posterior", "circumferential"] as ApproachKey[]).map(
                        key => (
                          <div key={key}>
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] text-slate-700 capitalize">
                                {key}
                              </span>
                              <span className="text-[11px] font-semibold text-slate-900">
                                {approachProbs[key].toFixed(1)}%
                              </span>
                            </div>
                            <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-indigo-400"
                                style={{ width: `${approachProbs[key]}%` }}
                              />
                            </div>
                          </div>
                        )
                      )}
                    </div>
                    <p className="text-[11px] text-slate-600 mt-1">
                      Patterns combine literature-based preferences (e.g., multilevel
                      disease, kyphosis, OPLL) with model-style estimates derived from
                      synthetic DCM outcome data. They are for shared
                      decision-making conversations and do not replace individualized
                      surgical planning.
                    </p>
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}

      {tab === "batch" && (
        <section className="bg-white rounded-3xl shadow-sm border border-slate-100 p-6 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900">Batch (CSV)</h2>
          <p className="text-sm text-slate-600">
            Upload a CSV of patients to generate aggregated recommendations using the same
            frozen model as the single-patient view. Expected columns (header row):{" "}
            <code className="font-mono text-[11px]">
              age, sex, smoker, symptom_duration_months, baseline_mjoa, levels_operated,
              canal_ratio, t2_signal, opll, t1_hypointensity, gait_impairment,
              psych_disorder, baseline_ndi, baseline_sf36_pcs, baseline_sf36_mcs
            </code>
            .
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept=".csv"
              onChange={handleBatchFile}
              className="text-sm text-slate-700"
            />
            <button
              onClick={handlePrint}
              className="inline-flex items-center rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Print / Save as PDF
            </button>
          </div>

          {batchError && (
            <div className="mt-3 rounded-2xl bg-rose-50 border border-rose-100 px-4 py-3 text-xs text-rose-700">
              {batchError}
            </div>
          )}

          {batchRows.length > 0 && (
            <div className="mt-4 overflow-x-auto text-xs">
              <table className="min-w-full border border-slate-200 rounded-2xl overflow-hidden">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      Row
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      Age
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      Sex
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      mJOA
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      Severity
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      Surgery?
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      Risk&nbsp;no surg
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      Benefit&nbsp;surg
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      Best approach
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      P(MCID) ANT
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      P(MCID) POST
                    </th>
                    <th className="px-3 py-2 text-left font-semibold text-slate-700">
                      P(MCID) CIRC
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {batchRows.map(row => (
                    <tr key={row.rowIndex} className="border-t border-slate-200">
                      <td className="px-3 py-2">{row.rowIndex}</td>
                      <td className="px-3 py-2">{row.input.age ?? ""}</td>
                      <td className="px-3 py-2">{row.input.sex}</td>
                      <td className="px-3 py-2">{row.input.baselineMJOA ?? ""}</td>
                      <td className="px-3 py-2">{row.riskBenefit.severity}</td>
                      <td className="px-3 py-2">
                        {row.surgeryRecommended ? "Surgery" : "Non-operative"}
                      </td>
                      <td className="px-3 py-2">{row.riskBenefit.riskScore}%</td>
                      <td className="px-3 py-2">{row.riskBenefit.benefitScore}%</td>
                      <td className="px-3 py-2 capitalize">{row.approach.best}</td>
                      <td className="px-3 py-2">
                        {row.approach.probs.anterior.toFixed(1)}%
                      </td>
                      <td className="px-3 py-2">
                        {row.approach.probs.posterior.toFixed(1)}%
                      </td>
                      <td className="px-3 py-2">
                        {row.approach.probs.circumferential.toFixed(1)}%
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
  );
}
