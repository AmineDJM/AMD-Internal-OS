import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, FileText, ShieldCheck, ShieldAlert, ShieldX, Layers, History, Eye, CheckCircle2, XCircle, AlertTriangle, Info, ListChecks, Gauge, Bot, GitCompare, MailWarning, FlaskConical, MessagesSquare, Library } from "lucide-react";
import type { RegFindingSeverity } from "@prisma/client";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { ReminderButton } from "@/components/reminders/reminder-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table } from "@/components/ui/table";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { getDossier, listVersions, listVersionDocuments, getAssessment, listFindings, listFacts, listConflicts, reservesByIds, documentNamesByIds } from "@/lib/regulatory/intelligence/queries";
import { findingQuality } from "@/lib/regulatory/intelligence/findings/enrich";
import { buildCoverage, buildRegistrationDocs } from "@/lib/regulatory/intelligence/twin/build-twin";
import { buildVersionDiff } from "@/lib/regulatory/intelligence/diff/compare-versions";
import { aiConfigured, cleModeleRequise } from "@/lib/ai";
import { applicableAgents } from "@/lib/regulatory/intelligence/agents/orchestrator";
import { listReserveCycles } from "@/lib/regulatory/intelligence/reserves/queries";
import { prisma } from "@/lib/prisma";
import { TwinPanel } from "./twin-panel";
import { AgentsPanel } from "./agents-panel";
import { DossierChatPanel } from "./chat-panel";
import { ReserveChatPanel } from "./reserve-chat-panel";
import { ReservesPanel } from "./reserves-panel";
import { SimulatorPanel } from "./simulator-panel";
import type { SimPerspective } from "@/lib/regulatory/intelligence/simulator/run";
import {
  PROCEDURE_TYPE_LABELS, DOSSIER_STATUS_LABELS, DOSSIER_STATUS_TONE,
  SECURITY_LABELS, EXTRACTION_LABELS, humanBytes, isBlockedSecurity,
} from "@/lib/regulatory/intelligence/labels";
import type { RegDocSecurityStatus } from "@prisma/client";
import { CtdUpload } from "./ctd-upload";
import { DeleteDossierButton } from "./dossier-actions";
import { FindingControls } from "./finding-actions";
import { FindingsReportButton } from "./report-buttons";
import { AnalysisProgressCard } from "./analysis-progress-card";
import { getAnalysisProgress } from "@/lib/regulatory/intelligence/progress/query";
import { SubmissionGate } from "./submission-gate";
import { ApproveNameButton } from "./approve-name";

export const dynamic = "force-dynamic";

const fmtDateTime = (d: Date) =>
  new Date(d).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

function securityIcon(s: RegDocSecurityStatus) {
  if (s === "SAFE") return <ShieldCheck className="h-3.5 w-3.5 text-success" />;
  if (s === "SUSPICIOUS") return <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />;
  return <ShieldX className="h-3.5 w-3.5 text-destructive" />;
}

const INLINE_EXT = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "txt", "csv", "xml"]);

const SEVERITY_META: Record<RegFindingSeverity, { label: string; cls: string; Icon: typeof XCircle }> = {
  CRITICAL: { label: "Critique", cls: "border-destructive/40 bg-destructive/5 text-destructive", Icon: XCircle },
  MAJOR: { label: "Majeur", cls: "border-amber-500/40 bg-amber-500/5 text-amber-600", Icon: AlertTriangle },
  MINOR: { label: "Mineur", cls: "border-blue-500/30 bg-blue-500/5 text-blue-600", Icon: Info },
  INFO: { label: "Info", cls: "border-border bg-muted/40 text-muted-foreground", Icon: Info },
};

export default async function DossierDetailPage(props: { params: Promise<{ dossierId: string }> }) {
  const params = await props.params;
  const user = await requireModule("REGULATORY");
  if (!regCan(user, "regulatory.workspace.view")) notFound();

  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) notFound();

  const dossier = await getDossier(companyId, params.dossierId);
  if (!dossier) notFound();

  const versions = await listVersions(dossier.id);
  const latest = versions[0];
  const documents = latest ? await listVersionDocuments(latest.id) : [];
  // Progression VIVANTE de l'analyse : rendue côté serveur (pas de clignotement), puis la carte
  // cliente s'actualise seule tant que ça tourne.
  const progress = latest ? await getAnalysisProgress(latest.id, dossier.status) : null;
  const assessment = latest ? await getAssessment(latest.id) : null;
  const findings = latest ? await listFindings(latest.id) : [];
  // Réserves ANPP rapprochées et noms des documents visés : chargés EN UNE FOIS chacun
  // (sinon une requête par constat).
  const [reservesById, findingDocNames] = await Promise.all([
    reservesByIds(findings.flatMap((f) => f.similarReserveIds)),
    documentNamesByIds(findings.map((f) => f.documentId)),
  ]);
  const facts = latest ? await listFacts(latest.id) : [];
  const conflicts = latest ? await listConflicts(latest.id) : [];
  const coverage = latest ? buildCoverage(dossier.procedureType, documents) : [];
  const registrationDocs = latest ? buildRegistrationDocs(documents) : [];
  const agents = latest ? await applicableAgents(latest.id) : [];
  const diff = versions.length > 1 ? await buildVersionDiff(dossier.id) : null;
  const generatedDocs = latest
    ? (await prisma.regulatoryGeneratedDoc.findMany({
        where: { dossierVersionId: latest.id }, orderBy: { createdAt: "desc" }, take: 20,
        select: { id: true, filename: true, templateVersion: true, factsUsed: true, factsMissing: true, createdAt: true },
      })).map((d) => ({ ...d, createdAt: d.createdAt.toISOString() }))
    : [];
  const reserveCycles = (await listReserveCycles(dossier.id)).map((c) => ({ ...c, receivedAt: c.receivedAt.toISOString() }));
  const canReserve = regCan(user, "regulatory.reserve.manage");
  const lastSimRow = latest
    ? await prisma.regulatorySimulation.findFirst({ where: { dossierVersionId: latest.id, configured: true }, orderBy: { createdAt: "desc" }, select: { perspectives: true, overall: true, createdAt: true } })
    : null;
  const lastSim = lastSimRow
    ? { perspectives: lastSimRow.perspectives as unknown as SimPerspective[], overall: lastSimRow.overall, createdAt: lastSimRow.createdAt.toISOString() }
    : null;

  const canUpload = regCan(user, "regulatory.dossier.upload");
  const canDelete =
    user.role === "SUPER_ADMIN" || regCan(user, "regulatory.admin") ||
    regCan(user, "regulatory.workspace.manage") || dossier.createdById === user.id;
  const canView = regCan(user, "regulatory.document.view");
  const canEditFinding = regCan(user, "regulatory.finding.edit");
  const canApproveFinding = regCan(user, "regulatory.finding.approve");
  const canApproveDoc = regCan(user, "regulatory.document.approve");
  const canPrepare = regCan(user, "regulatory.submission.prepare");
  const canApproveSubmission = regCan(user, "regulatory.submission.approve");
  const canAnalyse = regCan(user, "regulatory.dossier.analyse");
  const openBlockers = findings.filter((f) => f.blocker && (f.status === "OPEN" || f.status === "ACKNOWLEDGED")).length;

  // ── VERDICT GO / NO-GO : la réponse à LA question du pharmacien — « puis-je déposer ? ».
  // Bloqueur ou critique OUVERT → NO-GO ; majeur ouvert ou complétude imparfaite → GO sous
  // conditions ; sinon GO. Les constats résolus/levés ne comptent plus : le verdict reflète
  // l'état PRÉSENT du dossier, pas son historique.
  const isOpen = (f: { status: string }) => f.status === "OPEN" || f.status === "ACKNOWLEDGED";
  const openCriticals = findings.filter((f) => f.severity === "CRITICAL" && isOpen(f)).length;
  const openMajors = findings.filter((f) => f.severity === "MAJOR" && isOpen(f)).length;
  const verdict: "GO" | "WARN" | "NOGO" | null =
    !latest || (!assessment && findings.length === 0)
      ? null
      : openBlockers > 0 || openCriticals > 0
        ? "NOGO"
        : openMajors > 0 || (assessment != null && (!assessment.conforme || assessment.completeness < 100))
          ? "WARN"
          : "GO";
  // Réserves ANPP les plus PROBABLES : précédents réels (reserveRisk) quand on en a, sinon la
  // gravité comme approximation honnête — jamais un pourcentage inventé présenté comme mesuré.
  const RISK_BASE: Record<RegFindingSeverity, number> = { CRITICAL: 0.85, MAJOR: 0.55, MINOR: 0.25, INFO: 0.05 };
  const probableReserves = findings
    .filter((f) => f.severity !== "INFO" && isOpen(f))
    .map((f) => ({ f, risk: Math.max(f.reserveRisk ?? 0, RISK_BASE[f.severity]), measured: f.reserveRisk != null }))
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 5);

  return (
    <div className="space-y-5">
      <Link href="/regulatory/enregistrement/analyse" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Retour aux dossiers
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title={dossier.title} description={`${dossier.reference} · ${PROCEDURE_TYPE_LABELS[dossier.procedureType]}`} />
        <div className="flex flex-wrap items-center gap-2">
          <ReminderButton defaultTitle={`Dossier ${dossier.reference} — ${dossier.title}`} link={`/regulatory/enregistrement/analyse/${dossier.id}`} />
          <Badge tone={DOSSIER_STATUS_TONE[dossier.status]} dot>{DOSSIER_STATUS_LABELS[dossier.status]}</Badge>
          {canDelete && <DeleteDossierButton dossierId={dossier.id} />}
        </div>
      </div>

      {/* PROGRESSION VIVANTE — quand l'analyse tourne, elle passe AVANT tout le reste : c'est
          la réponse à « où en est-on ? ». S'actualise seule et disparaît une fois terminée. */}
      {progress && (progress.running || progress.aiFailure || progress.aiFoundNothing) && (
        <AnalysisProgressCard versionId={latest!.id} initial={progress} />
      )}

      {/* VERDICT GO / NO-GO — la synthèse qu'on lit en trois secondes avant tout le reste.
          Un seul mot, sa raison, l'état chiffré, et les réserves les plus probables. */}
      {verdict && (
        <Card className={`overflow-hidden ${verdict === "NOGO" ? "border-destructive/50" : verdict === "WARN" ? "border-amber-500/50" : "border-success/50"}`}>
          <CardContent className="p-0">
            <div className={`flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-4 sm:px-5 ${verdict === "NOGO" ? "bg-destructive/5" : verdict === "WARN" ? "bg-amber-500/5" : "bg-success/5"}`}>
              <div className="flex min-w-0 items-center gap-3">
                <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${verdict === "NOGO" ? "bg-destructive/15 text-destructive" : verdict === "WARN" ? "bg-amber-500/15 text-amber-600" : "bg-success/15 text-success"}`}>
                  {verdict === "NOGO" ? <ShieldX className="h-6 w-6" /> : verdict === "WARN" ? <ShieldAlert className="h-6 w-6" /> : <ShieldCheck className="h-6 w-6" />}
                </span>
                <div className="min-w-0">
                  <p className={`text-lg font-bold leading-tight ${verdict === "NOGO" ? "text-destructive" : verdict === "WARN" ? "text-amber-600" : "text-success"}`}>
                    {verdict === "NOGO" ? "NO-GO — ne pas soumettre en l'état" : verdict === "WARN" ? "GO SOUS CONDITIONS — corriger avant dépôt" : "GO — prêt à soumettre"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {verdict === "NOGO"
                      ? [openBlockers > 0 ? `${openBlockers} bloqueur·s ouvert·s` : null, openCriticals > 0 ? `${openCriticals} constat·s critique·s ouvert·s` : null].filter(Boolean).join(" · ")
                      : verdict === "WARN"
                        ? [openMajors > 0 ? `${openMajors} constat·s majeur·s ouvert·s` : null, assessment && assessment.completeness < 100 ? `complétude ${assessment.completeness} %` : null, assessment && !assessment.conforme ? "non conforme en l'état" : null].filter(Boolean).join(" · ")
                        : "Aucun bloqueur ni constat critique ou majeur ouvert."}
                  </p>
                </div>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-3">
                {assessment && (
                  <div className="text-right">
                    <p className="text-2xl font-semibold tabular-nums leading-none">{assessment.completeness}%</p>
                    <p className="text-[0.6875rem] text-muted-foreground">complétude CTD</p>
                  </div>
                )}
                <div className="flex flex-col gap-1 text-[0.6875rem]">
                  {openBlockers > 0 && <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">{openBlockers} bloqueur·s</span>}
                  {openCriticals > 0 && <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">{openCriticals} critique·s</span>}
                  {openMajors > 0 && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-600">{openMajors} majeur·s</span>}
                  {openBlockers === 0 && openCriticals === 0 && openMajors === 0 && <span className="rounded-full bg-success/10 px-2 py-0.5 text-success">rien d&apos;ouvert</span>}
                </div>
              </div>
            </div>

            {probableReserves.length > 0 && (
              <div className="border-t border-border/60 px-4 py-3 sm:px-5">
                <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">Réserves ANPP les plus probables</p>
                <ul className="mt-1.5 space-y-1">
                  {probableReserves.map(({ f, risk, measured }) => (
                    <li key={f.id} className="flex items-center gap-2 text-xs">
                      <span
                        title={measured ? "Probabilité mesurée sur nos précédents ANPP" : "Estimation d'après la gravité (pas encore de précédent ANPP comparable)"}
                        className={`w-12 shrink-0 rounded px-1.5 py-0.5 text-center font-semibold tabular-nums ${risk >= 0.6 ? "bg-destructive/10 text-destructive" : risk >= 0.3 ? "bg-amber-500/10 text-amber-600" : "bg-secondary text-muted-foreground"}`}
                      >
                        {Math.round(risk * 100)} %{measured ? "" : "*"}
                      </span>
                      <span className="min-w-0 flex-1 truncate" title={f.title}>{f.title}</span>
                      {f.sectionCode && <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[0.6875rem] font-medium">CTD {f.sectionCode}</span>}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[0.6875rem] text-muted-foreground/80">* estimation d&apos;après la gravité, faute de précédent ANPP comparable.</p>
              </div>
            )}

            <p className="border-t border-border/60 px-4 py-2 text-[0.6875rem] text-muted-foreground sm:px-5">
              Aide à la décision — la décision de soumettre appartient au <strong>pharmacien directeur technique</strong>.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Téléversement du dossier CTD (ZIP) */}
      {canUpload && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="h-4 w-4 text-primary" /> {versions.length === 0 ? "Téléverser le dossier CTD (ZIP)" : "Nouvelle version du dossier (ZIP)"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CtdUpload dossierId={dossier.id} />
          </CardContent>
        </Card>
      )}

      {/* Manifeste de la dernière version */}
      {latest && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-primary" /> Manifeste — version {latest.versionNo}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="text-success">{latest.counts.safe} sain·s</span>
              {latest.counts.suspicious > 0 && <span className="text-amber-600">{latest.counts.suspicious} à vérifier</span>}
              {latest.counts.blocked > 0 && <span className="text-destructive">{latest.counts.blocked} bloqué·s</span>}
              {canView && latest.originalZipBlobId && (
                <Link href={`/api/regulatory/intelligence/version/${latest.id}/original`}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-2 font-medium hover:bg-accent sm:px-2 sm:py-1">
                  <Download className="h-3.5 w-3.5" /> Archive originale
                </Link>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {(() => {
              const extracted = documents.filter((d) => d.extractionStatus === "TEXT_EXTRACTED" || d.extractionStatus === "OCR_COMPLETED").length;
              const ocr = documents.filter((d) => d.extractionStatus === "OCR_REQUIRED").length;
              const pending = documents.filter((d) => d.extractionStatus === "PENDING").length;
              return (
                <p className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>Texte extrait : <span className="font-medium text-foreground">{extracted}</span></span>
                  {ocr > 0 && <span>OCR requis (scans) : <span className="font-medium text-amber-600">{ocr}</span></span>}
                  {pending > 0 && <span>En attente d'extraction : <span className="font-medium">{pending}</span></span>}
                </p>
              );
            })()}
            {latest.originalSha256 && (
              <p className="mb-2 truncate font-mono text-[0.6875rem] text-muted-foreground" title={latest.originalSha256}>
                SHA-256 archive : {latest.originalSha256}
              </p>
            )}
            {/* Au téléphone, chaque pièce devient une carte : six colonnes ne tiennent pas dans 360 px. */}
            <Table>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Fichier &amp; nom proposé</th>
                    <th className="py-1.5 pr-3 font-medium">Classement CTD</th>
                    <th className="py-1.5 pr-3 font-medium">Taille</th>
                    <th className="py-1.5 pr-3 font-medium">Sécurité</th>
                    <th className="py-1.5 pr-3 font-medium">Extraction</th>
                    <th className="py-1.5 font-medium text-right">Aperçu</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((doc) => {
                    const blocked = isBlockedSecurity(doc.securityStatus);
                    const canPreview = canView && !!doc.blobId && !blocked;
                    const inline = INLINE_EXT.has(doc.ext.toLowerCase());
                    return (
                      <tr key={doc.id} className="border-b border-border/60 align-top">
                        <td data-sans-etiquette className="py-1.5 pr-3">
                          <div className="min-w-0 max-w-full">
                          <span className="block max-w-[22rem] truncate font-medium" title={doc.originalPath}>{doc.originalFilename}</span>
                          {doc.approvedFilename ? (
                            <span className="block max-w-[22rem] truncate text-[0.6875rem] text-success" title={doc.approvedFilename}>✓ {doc.approvedFilename}</span>
                          ) : doc.suggestedFilename && !blocked ? (
                            <span className="flex items-center gap-1.5">
                              <span className="min-w-0 max-w-[18rem] truncate text-[0.6875rem] text-primary" title={doc.suggestedFilename}>→ {doc.suggestedFilename}</span>
                              {canApproveDoc && <ApproveNameButton documentId={doc.id} />}
                            </span>
                          ) : null}
                          </div>
                        </td>
                        <td className="py-1.5 pr-3">
                          <div>
                          {blocked ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : doc.ctdSection ? (
                            <span className="inline-flex flex-col">
                              <span className="text-xs font-medium">{doc.ctdSection}</span>
                              <span className="max-w-[12rem] truncate text-[0.6875rem] text-muted-foreground" title={`${doc.ctdModule ?? ""} — confiance ${Math.round((doc.ctdConfidence ?? 0) * 100)}%`}>
                                {doc.ctdModule} · {Math.round((doc.ctdConfidence ?? 0) * 100)}%
                              </span>
                            </span>
                          ) : doc.ctdModule ? (
                            <span className="text-xs text-muted-foreground">{doc.ctdModule} · à préciser</span>
                          ) : (
                            <span className="text-xs text-amber-600">non classé</span>
                          )}
                          {!blocked && doc.containedSections.filter((s) => s !== doc.ctdSection).length > 0 && (
                            <span className="mt-0.5 block max-w-[13rem] truncate text-[0.6875rem] text-primary"
                              title={`Sections CTD aussi présentes dans ce PDF consolidé : ${doc.containedSections.join(", ")}`}>
                              contient : {doc.containedSections.filter((s) => s !== doc.ctdSection).slice(0, 6).join(", ")}
                            </span>
                          )}
                          </div>
                        </td>
                        <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{humanBytes(doc.sizeBytes)}</td>
                        <td className="py-1.5 pr-3">
                          <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs">{securityIcon(doc.securityStatus)} {SECURITY_LABELS[doc.securityStatus]}</span>
                        </td>
                        <td className="py-1.5 pr-3 whitespace-nowrap text-xs text-muted-foreground">{blocked ? "—" : EXTRACTION_LABELS[doc.extractionStatus]}</td>
                        <td className="py-1.5 text-right">
                          {canPreview ? (
                            <Link href={`/api/regulatory/intelligence/document/${doc.id}${inline ? "?inline=1" : ""}`}
                              target="_blank" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                              {inline ? <Eye className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />} {inline ? "Voir" : "Télécharger"}
                            </Link>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Bilan de conformité (moteur déterministe) */}
      {assessment && (
        <Card className={assessment.conforme ? "border-success/40" : "border-destructive/40"}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Gauge className="h-4 w-4 text-primary" /> Bilan de complétude &amp; conformité</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <p className="text-3xl font-semibold">{assessment.completeness}%</p>
                <p className="text-xs text-muted-foreground">Complétude ({assessment.requiredPresent}/{assessment.requiredTotal} sections obligatoires)</p>
              </div>
              <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${assessment.conforme ? "border-success/40 bg-success/10 text-success" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>
                {assessment.conforme ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                {assessment.conforme ? "Aucun bloqueur détecté" : `${assessment.blockers} bloqueur·s — non conforme en l'état`}
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                {assessment.criticals > 0 && <span className="rounded-md bg-destructive/10 px-2 py-1 text-destructive">{assessment.criticals} critique·s</span>}
                {assessment.majors > 0 && <span className="rounded-md bg-amber-500/10 px-2 py-1 text-amber-600">{assessment.majors} majeur·s</span>}
                {assessment.minors > 0 && <span className="rounded-md bg-blue-500/10 px-2 py-1 text-blue-600">{assessment.minors} mineur·s</span>}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Un score élevé ne vaut pas conformité : tout <strong>bloqueur</strong> (section obligatoire manquante, dossier vide) prime.
              Ce bilan est une <strong>aide</strong> — la décision finale revient au pharmacien directeur technique.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Porte de soumission */}
      {latest && (canPrepare || canApproveSubmission || canAnalyse) && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-primary" /> Porte de soumission</CardTitle></CardHeader>
          <CardContent>
            <SubmissionGate
              dossierId={dossier.id} status={dossier.status} openBlockers={openBlockers}
              canPrepare={canPrepare} canApprove={canApproveSubmission} canAnalyse={canAnalyse}
            />
          </CardContent>
        </Card>
      )}

      {/* Couverture CTD (jumeau numérique) */}
      {coverage.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ListChecks className="h-4 w-4 text-primary" /> Couverture CTD attendue</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {coverage.map((row) => (
                <div key={`${row.kind}-${row.code}`} className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-sm">
                  {row.present ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : <XCircle className={`h-4 w-4 shrink-0 ${row.kind === "required" ? "text-destructive" : "text-amber-600"}`} />}
                  <span className="font-medium">{row.code}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={row.title}>{row.title}</span>
                  {row.kind === "required" && <span className="shrink-0 text-[0.6875rem] uppercase tracking-wide text-muted-foreground/70">obligatoire</span>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pièces administratives d'enregistrement — HORS dossier CTD (fournies de notre côté, en ligne
          sur le portail ANPP). Rappel obligatoire ; leur absence ne pénalise JAMAIS la complétude CTD. */}
      {latest && registrationDocs.length > 0 && (
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><FileText className="h-4 w-4 text-primary" /> Documents obligatoires pour l&apos;enregistrement (hors CTD)</CardTitle>
            <p className="text-xs text-muted-foreground">
              Ces pièces sont fournies de <strong>notre côté</strong> (portail ANPP en ligne) et ne font <strong>pas partie du dossier CTD</strong> :
              leur absence ici ne pénalise pas la notation du dossier. Rappel de la checklist à joindre à la soumission.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {registrationDocs.map((row) => (
                <div key={row.code} className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-sm">
                  {row.present
                    ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                    : <Info className="h-4 w-4 shrink-0 text-muted-foreground/70" />}
                  <span className="font-medium">{row.code}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={row.label}>{row.label}</span>
                  <span className="shrink-0 text-[0.6875rem] uppercase tracking-wide text-muted-foreground/70">
                    {row.present ? "joint" : "à fournir"}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agents spécialisés (revue de fond IA — PROJET, sur demande) */}
      {latest && agents.length > 0 && canAnalyse && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Bot className="h-4 w-4 text-primary" /> Agents spécialisés — revue de fond (PROJET)</CardTitle>
          </CardHeader>
          <CardContent>
            <AgentsPanel dossierId={dossier.id} agents={agents} configured={aiConfigured()} cleIa={cleModeleRequise()} />
          </CardContent>
        </Card>
      )}

      {/* Chatbot du dossier — questions/réponses ancrées, avec sources exactes (fichier · section · page) */}
      {latest && canView && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><MessagesSquare className="h-4 w-4 text-primary" /> Discuter avec ce dossier</CardTitle>
            <p className="text-xs text-muted-foreground">
              Posez vos questions ; chaque réponse s'appuie sur les <strong>documents réellement lus</strong> et cite ses{" "}
              <strong>sources exactes</strong>. L'assistant s'abstient hors de ce que contient le dossier (jamais d'invention).
            </p>
          </CardHeader>
          <CardContent>
            <DossierChatPanel dossierId={dossier.id} configured={aiConfigured()} canView={canView} />
          </CardContent>
        </Card>
      )}

      {/* Jumeau numérique — faits sourcés + conflits */}
      {latest && (facts.length > 0 || conflicts.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Layers className="h-4 w-4 text-primary" /> Jumeau numérique — faits réglementaires</CardTitle>
            <p className="text-xs text-muted-foreground">
              Faits extraits par <strong>règles déterministes</strong> ET <strong>compréhension IA</strong> (marqués « IA »), chacun avec sa{" "}
              <strong>preuve sourcée</strong> vérifiée dans le document. Conflits entre documents détectés. Valeurs proposées — à confirmer/corriger.
            </p>
          </CardHeader>
          <CardContent>
            <TwinPanel
              facts={facts.map((f) => ({ ...f, occurrences: f.occurrences }))}
              conflicts={conflicts.map((c) => ({ ...c, values: (c.values as unknown as { value: string; documentId: string; sectionCode: string | null; extract: string; confidence: number }[]) }))}
              canEdit={canEditFinding}
              canApprove={canApproveFinding}
            />
          </CardContent>
        </Card>
      )}

      {/* Constats — l'écran que le pharmacien lit vraiment. Trois principes :
          1. la GRAVITÉ structure la page (le critique d'abord, avec compteurs) ;
          2. chaque constat mène à SA PIÈCE — la page est un LIEN qui ouvre le PDF au bon endroit ;
          3. la hiérarchie visuelle suit la lecture : titre → preuve → quoi faire → précédents. */}
      {findings.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
            <CardTitle className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
              <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-primary" /> Constats</span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs font-normal">
                {(["CRITICAL", "MAJOR", "MINOR", "INFO"] as const).map((sev) => {
                  const n = findings.filter((x) => x.severity === sev).length;
                  if (n === 0) return null;
                  const m = SEVERITY_META[sev];
                  return <span key={sev} className={`rounded-full border px-2 py-0.5 ${m.cls}`}>{n} {m.label.toLowerCase()}{n > 1 && sev !== "INFO" ? "s" : ""}</span>;
                })}
              </span>
            </CardTitle>
            {canAnalyse && <FindingsReportButton dossierId={dossier.id} />}
          </CardHeader>
          <CardContent className="space-y-4">
            {(["CRITICAL", "MAJOR", "MINOR", "INFO"] as const).map((sev) => {
              const group = findings.filter((x) => x.severity === sev);
              if (group.length === 0) return null;
              const meta = SEVERITY_META[sev];
              return (
                <div key={sev} className="space-y-2">
                  <p className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
                    <meta.Icon className="h-3.5 w-3.5" /> {meta.label} ({group.length})
                  </p>
                  {group.map((f) => {
                    const docName = f.documentId ? findingDocNames.get(f.documentId) ?? null : null;
                    const quality = findingQuality(f);
                    return (
                      <div key={f.id} className={`overflow-hidden rounded-xl border ${meta.cls.split(" ")[0]} bg-card`}>
                        {/* Liseré de gravité : la couleur se voit avant que le texte se lise. */}
                        <div className={`flex items-stretch`}>
                          <div className={`w-1 shrink-0 ${sev === "CRITICAL" ? "bg-destructive" : sev === "MAJOR" ? "bg-amber-500" : sev === "MINOR" ? "bg-blue-500" : "bg-border"}`} />
                          <div className="min-w-0 flex-1 px-3 py-2.5">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-sm font-semibold text-foreground">{f.title}</span>
                              {f.blocker && <span className="rounded bg-destructive px-1.5 py-0.5 text-[0.6875rem] font-semibold text-white">BLOQUEUR</span>}
                              {f.source === "AI" && f.draft && <span className="rounded bg-amber-500/90 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-white">PROJET IA — À RELIRE</span>}
                              {f.source === "HUMAN" && <span className="rounded bg-primary px-1.5 py-0.5 text-[0.6875rem] font-semibold text-white">HUMAIN</span>}
                              {quality.defensible && <span className="rounded bg-success/15 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-success">DÉFENDABLE</span>}
                            </div>

                            {/* OÙ : document, section, page — et la page est un LIEN vers la pièce. */}
                            {(docName || f.sectionCode || f.page != null) && (
                              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                                {docName && <span className="inline-flex items-center gap-1"><FileText className="h-3 w-3" /> {docName}</span>}
                                {f.sectionCode && <span className="rounded bg-secondary px-1.5 py-0.5 font-medium text-foreground">CTD {f.sectionCode}</span>}
                                {f.page != null && f.documentId ? (
                                  <a
                                    href={`/api/regulatory/intelligence/document/${f.documentId}?inline=1#page=${f.page}`}
                                    target="_blank" rel="noreferrer noopener"
                                    title="Ouvrir la pièce à cette page"
                                    className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-semibold text-primary hover:bg-primary/20"
                                  >
                                    <Eye className="h-3 w-3" /> p. {f.page}
                                  </a>
                                ) : f.page != null ? (
                                  <span className="rounded bg-secondary px-1.5 py-0.5">p. {f.page}</span>
                                ) : null}
                              </p>
                            )}

                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.detail}</p>
                            <FindingEvidence finding={f} reserves={reservesById} docNames={findingDocNames} />
                            <FindingControls findingId={f.id} status={f.status} blocker={f.blocker} canEdit={canEditFinding} canApprove={canApproveFinding} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Documents produits — rapport de constats et lettres de réponse. Liste de
          TÉLÉCHARGEMENT seulement : la génération à partir de modèles à trous a été retirée
          (elle rendait des coquilles à remplir à la main, pas du travail fait). */}
      {generatedDocs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><FileText className="h-4 w-4 text-primary" /> Documents produits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {generatedDocs.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate font-medium" title={d.filename}>{d.filename}</span>
                <span className="shrink-0 text-muted-foreground">{fmtDateTime(new Date(d.createdAt))}</span>
                <a href={`/api/regulatory/intelligence/generated/${d.id}`} className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline">
                  <Download className="h-3.5 w-3.5" /> Télécharger
                </a>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Reviewer Simulator — stress test multi-perspectives (simulation non prédictive) */}
      {latest && canAnalyse && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><FlaskConical className="h-4 w-4 text-primary" /> Simulateur d'examen (multi-perspectives)</CardTitle>
          </CardHeader>
          <CardContent>
            <SimulatorPanel dossierId={dossier.id} last={lastSim} />
          </CardContent>
        </Card>
      )}

      {/* Réserves ANPP — lettre océrisée, points décomposés, réponses */}
      {(canReserve || reserveCycles.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><MailWarning className="h-4 w-4 text-primary" /> Réserves ANPP</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ReservesPanel dossierId={dossier.id} cycles={reserveCycles} canManage={canReserve} />
            {reserveCycles.some((c) => c.points.length > 0) && canView && (
              <div className="space-y-1.5">
                <p className="flex items-center gap-2 text-sm font-semibold"><MessagesSquare className="h-4 w-4 text-primary" /> Discuter avec les réserves</p>
                <ReserveChatPanel dossierId={dossier.id} configured={aiConfigured()} />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Comparaison V1/V2 — ce qui a changé entre les deux dernières versions */}
      {diff && diff.hasOld && (diff.summary.added + diff.summary.removed + diff.summary.replaced + diff.summary.factsChanged > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><GitCompare className="h-4 w-4 text-primary" /> Comparaison v{diff.oldVersionNo} → v{diff.newVersionNo}</CardTitle>
            <p className="text-xs text-muted-foreground">
              Fichiers remplacés/ajoutés/supprimés (identité par chemin, contenu par SHA-256) et évolution des faits.
              Concentrez la ré-évaluation sur ces changements — la décision reste humaine.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              {diff.summary.replaced > 0 && <span className="rounded-md bg-amber-500/10 px-2 py-1 text-amber-600">{diff.summary.replaced} remplacé·s</span>}
              {diff.summary.added > 0 && <span className="rounded-md bg-success/10 px-2 py-1 text-success">{diff.summary.added} ajouté·s</span>}
              {diff.summary.removed > 0 && <span className="rounded-md bg-destructive/10 px-2 py-1 text-destructive">{diff.summary.removed} supprimé·s</span>}
              <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">{diff.summary.unchanged} inchangé·s</span>
              {diff.summary.factsChanged > 0 && <span className="rounded-md bg-blue-500/10 px-2 py-1 text-blue-600">{diff.summary.factsChanged} fait·s modifié·s</span>}
            </div>

            {diff.files.some((fl) => fl.status !== "unchanged") && (
              <div className="space-y-1">
                {diff.files.filter((fl) => fl.status !== "unchanged").map((fl) => (
                  <div key={`${fl.status}-${fl.path}`} className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-xs">
                    <span className={`rounded px-1.5 py-0.5 font-medium ${fl.status === "replaced" ? "bg-amber-500/10 text-amber-600" : fl.status === "added" ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
                      {fl.status === "replaced" ? "Remplacé" : fl.status === "added" ? "Ajouté" : "Supprimé"}
                    </span>
                    <span className="min-w-0 flex-1 truncate" title={fl.path}>{fl.filename}</span>
                    {fl.ctdSection && <span className="shrink-0 text-muted-foreground">{fl.ctdSection}</span>}
                  </div>
                ))}
              </div>
            )}

            {diff.facts.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Faits réglementaires</p>
                {diff.facts.map((ft) => (
                  <div key={ft.factKey} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-xs">
                    <span className={`rounded px-1.5 py-0.5 ${ft.status === "changed" ? "bg-blue-500/10 text-blue-600" : ft.status === "added" ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
                      {ft.status === "changed" ? "Modifié" : ft.status === "added" ? "Ajouté" : "Supprimé"}
                    </span>
                    <span className="font-medium">{ft.label}</span>
                    {ft.status === "changed" && <span className="text-muted-foreground">{ft.oldValue ?? "—"} → <span className="text-foreground">{ft.newValue ?? "—"}</span></span>}
                    {ft.status === "added" && <span className="text-foreground">{ft.newValue}</span>}
                    {ft.status === "removed" && <span className="text-muted-foreground line-through">{ft.oldValue}</span>}
                  </div>
                ))}
              </div>
            )}
            {canAnalyse && <p className="text-xs text-muted-foreground">Relancez les contrôles pour ré-évaluer la nouvelle version (les décisions humaines sur les constats sont conservées).</p>}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><GitCompare className="h-4 w-4 text-primary" /> Comparaison v{diff.oldVersionNo} → v{diff.newVersionNo}</CardTitle></CardHeader>
          <CardContent><p className="text-sm text-muted-foreground">Aucune différence de fichier ni de fait entre ces deux versions.</p></CardContent>
        </Card>
      ))}

      {/* Historique des versions */}
      {versions.length > 1 && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4 text-primary" /> Versions</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {versions.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded-lg border border-border px-3 py-2 text-sm">
                <span className="font-medium">Version {v.versionNo}{v.label ? ` — ${v.label}` : ""}</span>
                <span className="text-xs text-muted-foreground">{v.fileCount} fichier·s · {humanBytes(v.totalBytes)} · {fmtDateTime(v.createdAt)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

    </div>
  );
}

type FindingRow = Awaited<ReturnType<typeof listFindings>>[number];
type ReserveMap = Awaited<ReturnType<typeof reservesByIds>>;

/**
 * CE QUI REND UN CONSTAT DÉFENDABLE — la partie qu'on présentera à l'agence.
 *
 * Un constat sans pièce n'est qu'une opinion. On affiche donc, quand ils existent : la règle
 * appliquée, la PAGE et l'EXTRAIT exact (on peut ouvrir le document et pointer la ligne), les
 * valeurs qui se contredisent entre documents, la recommandation — et les réserves ANPP
 * déjà reçues sur le même sujet.
 *
 * Quand un élément manque, on le DIT. Découvrir qu'un constat n'était pas étayé se fait ici,
 * pas en séance.
 */
function FindingEvidence({ finding: f, reserves, docNames }: { finding: FindingRow; reserves: ReserveMap; docNames: Map<string, string> }) {
  const quality = findingQuality(f);
  const linked = f.similarReserveIds.map((id) => reserves.get(id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
  // La preuve : l'extrait EXACT quand il existe (IA ancrée), sinon la preuve du moteur de
  // règles (`evidence` — ex. le comptage de caractères arabes). Même repli que le rapport .docx.
  const quote = f.excerpt ?? f.evidence;
  const hasAny = f.ruleRef || f.page != null || quote || f.recommendation || f.conflictingValues.length > 0 || linked.length > 0 || f.reserveRisk != null;
  if (!hasAny && quality.missing.length === 0) return null;

  const riskPct = f.reserveRisk != null ? Math.round(f.reserveRisk * 100) : null;

  return (
    <div className="mt-1.5 space-y-1.5 border-l-2 border-border/60 pl-2.5">
      {/* La règle et le degré de certitude. */}
      {(f.ruleRef || f.confidence != null) && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem] text-muted-foreground">
          {f.ruleRef && <span className="rounded bg-secondary px-1.5 py-0.5 font-medium text-foreground">{f.ruleRef}</span>}
          {f.confidence != null && <span>confiance {Math.round(f.confidence * 100)} %</span>}
        </p>
      )}

      {/* LA CITATION : ce qui est écrit dans la pièce, tel quel. Le « où » (document, page
          cliquable) vit désormais dans l'en-tête de la carte — ici, seulement la preuve. */}
      {quote && (
        <blockquote className="rounded-md border-l-2 border-primary/40 bg-secondary/50 px-2.5 py-1.5 text-[0.6875rem] leading-relaxed text-foreground">
          « {quote.length > 400 ? `${quote.slice(0, 400)}…` : quote} »
        </blockquote>
      )}

      {/* Ce qui se contredit — la raison d'être du constat quand il porte sur une incohérence. */}
      {f.conflictingValues.length > 0 && (
        <p className="text-[0.6875rem] text-muted-foreground">
          <span className="font-medium text-foreground">Valeurs contradictoires :</span>{" "}
          {f.conflictingValues.slice(0, 6).join("  ≠  ")}
        </p>
      )}

      {/* Quoi faire. */}
      {f.recommendation && (
        <p className="rounded-lg bg-primary/5 px-2 py-1 text-[0.6875rem] text-foreground">
          <span className="font-medium">À faire :</span> {f.recommendation}
        </p>
      )}

      {/* Les précédents ANPP — information, jamais règle de droit. */}
      {(linked.length > 0 || riskPct != null) && (
        <div className="rounded-lg border border-border/70 px-2 py-1.5">
          <p className="flex flex-wrap items-center gap-2 text-[0.6875rem]">
            <Library className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium text-foreground">Déjà vu à l&apos;ANPP</span>
            {riskPct != null && (
              <span className={riskPct >= 60 ? "text-destructive" : riskPct >= 30 ? "text-warning" : "text-muted-foreground"}>
                probabilité que la réserve revienne : {riskPct} %
              </span>
            )}
          </p>
          {linked.slice(0, 3).map((r) => (
            <div key={r.id} className="mt-1 text-[0.6875rem]">
              <span className={`mr-1.5 rounded px-1 py-0.5 text-[0.6875rem] font-semibold ${r.status === "ACCEPTED" ? "bg-success/15 text-success" : r.status === "REITERATED" ? "bg-destructive/15 text-destructive" : "bg-secondary text-muted-foreground"}`}>
                {r.status === "ACCEPTED" ? "réponse acceptée" : r.status === "REITERATED" ? "réitérée" : r.status.toLowerCase()}
              </span>
              <span className="text-muted-foreground">{r.verbatim.slice(0, 180)}{r.verbatim.length > 180 ? "…" : ""}</span>
              {r.status === "ACCEPTED" && r.response && (
                <p className="mt-0.5 rounded bg-success/10 px-2 py-1 text-[0.6875rem]">
                  <span className="font-medium">Réponse qui avait fonctionné :</span> {r.response.slice(0, 260)}
                </p>
              )}
            </div>
          ))}
          <p className="mt-1 text-[0.6875rem] text-muted-foreground/80">
            Précédent, pas règle de droit — la sévérité du constat n&apos;en a pas été modifiée.
          </p>
        </div>
      )}

      {/* L'honnêteté du constat : ce sur quoi il ne repose pas. */}
      {quality.missing.length > 0 && (
        <p className="flex items-start gap-1.5 text-[0.6875rem] text-muted-foreground/80">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-warning" />
          <span>
            {quality.defensible ? "Constat étayé. " : "Constat à étayer avant de l'opposer : "}
            manque {quality.missing.join(", ")}.
          </span>
        </p>
      )}
    </div>
  );
}
