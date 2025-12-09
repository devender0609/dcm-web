// app/page.tsx
import Image from "next/image";
import Link from "next/link";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top header with logo + clinic name */}
      <header className="w-full border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-center px-6 py-6">
          <div className="flex items-center justify-center">
            <Image
              src="/ascension-seton-logo.png"
              alt="Ascension Seton"
              width={260}
              height={60}
              priority
              className="h-12 w-auto"
            />
          </div>
          <h1 className="mt-3 text-center text-3xl font-semibold tracking-tight">
            Ascension Texas Spine and Scoliosis
          </h1>
          <p className="mt-1 text-center text-sm text-slate-500">
            Degenerative Cervical Myelopathy Decision-Support Tool
          </p>
        </div>
      </header>

      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-10">
        {/* Main description / 2-question cards */}
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-100 md:p-8">
          <h2 className="text-xl font-semibold tracking-tight">
            DCM Surgical Decision Support
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            This tool supports discussions about{" "}
            <span className="font-semibold">
              when to offer surgery and which approach may provide the highest
              chance of meaningful improvement
            </span>{" "}
            in degenerative cervical myelopathy (DCM). It integrates AO Spine /
            WFNS guideline concepts with synthetic outcome patterns derived from
            published surgical cohorts.
          </p>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            {/* Card 1 */}
            <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-5">
              <h3 className="text-sm font-semibold text-slate-800">
                1. Should this patient undergo surgery?
              </h3>
              <ul className="mt-3 space-y-2 text-sm text-slate-600">
                <li>
                  Uses baseline <strong>mJOA</strong>,{" "}
                  <strong>symptom duration</strong>, and{" "}
                  <strong>MRI cord signal / canal compromise</strong> to
                  classify patients as:
                </li>
                <li>
                  <strong>“Surgery recommended”</strong> – typically
                  moderate–severe or progressive DCM, or mild DCM with high-risk
                  markers.{" "}
                  <span className="text-xs text-slate-500">
                    (Fehlings et al., Global Spine J 2017; Tetreault et al.,
                    Neurosurgery 2021)
                  </span>
                </li>
                <li>
                  <strong>“Consider surgery”</strong> – mild DCM with risk
                  markers or patient-prioritized goals.
                </li>
                <li>
                  <strong>“Non-operative trial reasonable”</strong> – carefully
                  selected mild cases with structured follow-up and surveillance
                  imaging.
                </li>
              </ul>
            </div>

            {/* Card 2 */}
            <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-5">
              <h3 className="text-sm font-semibold text-slate-800">
                2. If surgery is offered, which approach?
              </h3>
              <ul className="mt-3 space-y-2 text-sm text-slate-600">
                <li>
                  Compares modeled probability of achieving{" "}
                  <strong>clinically meaningful mJOA improvement (MCID)</strong>{" "}
                  with anterior, posterior, and circumferential procedures.
                </li>
                <li>
                  Patterns reflect prognostic factors such as{" "}
                  <strong>
                    baseline severity, duration, age, smoking, multilevel
                    disease, OPLL, canal compromise, and MRI cord signal
                  </strong>
                  .{" "}
                  <span className="text-xs text-slate-500">
                    (Tetreault et al., Global Spine J 2017; Merali et al., PLoS
                    One 2019)
                  </span>
                </li>
                <li>
                  Literature-based rules (e.g., kyphosis, multilevel disease,
                  OPLL) can override small modeled differences when appropriate.
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-6">
            <Link href="/prototype">
              <button className="inline-flex items-center justify-center rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2">
                Launch decision-support view →
              </button>
            </Link>
          </div>
        </section>

        {/* References */}
        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-100 md:p-7">
          <h2 className="text-sm font-semibold text-slate-900">
            Key references informing the current logic
          </h2>
          <ul className="mt-3 space-y-1.5 text-sm leading-snug text-slate-600">
            <li>
              Fehlings MG, et al.{" "}
              <em>
                A Clinical Practice Guideline for the Management of Patients
                With Degenerative Cervical Myelopathy.
              </em>{" "}
              Global Spine J. 2017.
            </li>
            <li>
              Tetreault L, et al.{" "}
              <em>
                Change in Function, Pain, and Quality of Life Following
                Operative Treatment for DCM.
              </em>{" "}
              Global Spine J. 2017.
            </li>
            <li>
              Merali Z, et al.{" "}
              <em>
                Using a Machine Learning Approach to Predict Outcome After
                Surgery for DCM.
              </em>{" "}
              PLoS One. 2019.
            </li>
            <li>
              Matz PG, Fehlings MG, et al.{" "}
              <em>The Natural History of Cervical Spondylotic Myelopathy.</em> J
              Neurosurg Spine. 2009.
            </li>
            <li>
              Gulati S, et al.{" "}
              <em>
                Surgery for Degenerative Cervical Myelopathy: A Practical
                Overview.
              </em>{" "}
              Neurosurgery. 2021.
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}
