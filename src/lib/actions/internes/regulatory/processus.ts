/**
 * REGULATORY — le PROCESSUS ANPP lu et composé par les actions : une étape mise à jour, l'avis de présoumission,
 * l'avancement jusqu'à un jalon, les segments admis, les pièces d'un BV et l'ordre émis sous verrou (un BV de chaque
 * nature à la fois), et les dossiers Drive synchronisés après une ouverture du cadenas.
 *
 * Sorti de `actions/regulatory-actions.ts` (lot V4). Les écritures du dossier, les gardes et l'émission de l'ordre
 * (`createExpenseOrder`, passée ici en fonction) restent dans les actions.
 */
import { prisma } from "@/lib/prisma";
import type { RegulatoryStatus } from "@prisma/client";
import { getAppSettings } from "@/lib/settings";
import { validateUpload } from "@/lib/storage";
import { natureDuLibelle } from "@/lib/budget-regulatory/bv";
import { bloqueUneNouvelleDemande, etatDeLOrdreBv, ETAT_BV, type OrdrePourEtatBv } from "@/lib/regulatory/bv-circuit";
import { synchroniserDossierDrive } from "@/lib/regulatory-drive-dossier";
import {
  REG_PRESUB_OUTCOME, PRESUB_ANSWER_STEP, REG_STATUS_MILESTONE, completeStepsThrough, type RegPresubOutcome,
  type RegStepState, type RegWorkflowState,
} from "@/lib/regulatory-workflow";
import { effectiveTherapeuticSegments } from "@/lib/labels";

/** L'état d'une étape ANPP mis à jour (statut, date — celle du jour à « Fait » —, note ; une note absente garde la sienne). */
export function etapeMiseAJour(
  workflow: unknown, stepKey: string, status: RegStepState, date: string | null, note: string | null,
): RegWorkflowState {
  const wf = { ...((workflow as RegWorkflowState | null) ?? {}) };
  wf[stepKey] = {
    status,
    date: date && date.trim() ? date.trim() : (status === "DONE" ? new Date().toISOString().slice(0, 10) : wf[stepKey]?.date),
    note: note !== null ? (note.trim() || undefined) : wf[stepKey]?.note,
  };
  return wf;
}

/** L'avis de présoumission posé sur son étape : le statut d'étape dérive de l'avis (source unique). */
export function avisDePresoumission(
  workflow: unknown, outcome: RegPresubOutcome, note: string | null,
): { wf: RegWorkflowState; mapped: (typeof REG_PRESUB_OUTCOME)[RegPresubOutcome] } {
  const wf = { ...((workflow as RegWorkflowState | null) ?? {}) };
  const mapped = REG_PRESUB_OUTCOME[outcome];
  wf[PRESUB_ANSWER_STEP] = {
    status: mapped.status,
    outcome,
    date: mapped.status === "DONE" ? new Date().toISOString().slice(0, 10) : wf[PRESUB_ANSWER_STEP]?.date,
    note: note !== null ? (note.trim() || undefined) : wf[PRESUB_ANSWER_STEP]?.note,
  };
  return { wf, mapped };
}

/** Un `status` demandé se lit comme une DEMANDE D'AVANCEMENT : les étapes sont comptées jusqu'à son jalon. */
export function avancerJusquAuJalon(
  before: { status: RegulatoryStatus; workflow: unknown }, asked: RegulatoryStatus | null,
): { wf: RegWorkflowState; autoSteps: number } {
  const milestone = asked && asked !== before.status ? REG_STATUS_MILESTONE[asked] : undefined;
  let wf = (before.workflow as RegWorkflowState | null) ?? {};
  let autoSteps = 0;
  if (milestone) {
    const sync = completeStepsThrough(wf, milestone);
    if (sync.changed > 0) { wf = sync.state; autoSteps = sync.changed; }
  }
  return { wf, autoSteps };
}

/**
 * Les segments retenus : liste blanche réglée par l'administrateur (sinon la liste par défaut) ; un segment DÉJÀ posé
 * sur la fiche reste accepté même s'il a depuis quitté le référentiel — sinon on ne pourrait plus le retirer.
 */
export async function segmentsAdmis(actuels: string[] | null, envoyes: FormDataEntryValue[]): Promise<string[]> {
  const settings = await getAppSettings();
  const allowed = new Set([
    ...effectiveTherapeuticSegments(settings.regulatoryTherapeuticSegments),
    ...(actuels ?? []),
  ]);
  const picked = envoyes.map(String).filter((v) => allowed.has(v));
  return [...new Set(picked)];
}

/** Les pièces d'un BV se jugent AVANT l'ordre (§118.202) ; `null` = toutes recevables. */
export async function refusDesPieces(files: File[]): Promise<string | null> {
  if (files.length > 0) {
    const maxMb = (await getAppSettings()).maxUploadMb;
    for (const file of files) {
      const err = validateUpload(file.name, file.size, maxMb);
      if (err) return err;
    }
  }
  return null;
}

/** Ce qu'on lit d'un ordre BV déjà demandé. */
type OrdreBv = OrdrePourEtatBv & { reference: string; label: string };

/**
 * UN BV DE CETTE NATURE À LA FOIS, PAR DOSSIER : le contrôle et l'émission se font SOUS UN VERROU propre au couple
 * (dossier, nature). Rend l'ordre vivant qui bloque, ou celui qui vient d'être émis.
 */
export async function emettreSousVerrou<T>(
  productId: string, nature: string, emettre: () => Promise<T>,
): Promise<{ deja: OrdreBv; cree: null } | { deja: null; cree: T }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bv-demande'), hashtext(${`${productId}:${nature}`}))`;
    const existants = await tx.expenseOrder.findMany({
      where: { sourceType: "REGULATORY_PRODUCT", sourceId: productId, status: { not: "CANCELLED" } },
      select: { reference: true, label: true, status: true, centralStatus: true },
      orderBy: { createdAt: "desc" },
    });
    const vivant = existants.find((o) => natureDuLibelle(o.label) === nature && bloqueUneNouvelleDemande(o));
    if (vivant) return { deja: vivant, cree: null };
    return { deja: null, cree: await emettre() };
  }, { maxWait: 10_000, timeout: 30_000 });
}

/** Un BV déjà demandé : la seconde demande ferait payer deux fois le même bon. */
export function refusBvDejaDemande(bvType: string, deja: OrdreBv): string {
  const etat = etatDeLOrdreBv(deja) ?? "DEMANDE";
  return `Le ${bvType} de ce dossier est déjà demandé (${deja.reference} — ${ETAT_BV[etat].label.toLowerCase()}, ${ETAT_BV[etat].detail}). Une seconde demande ferait payer deux fois le même bon ; on ne redemande qu'un BV refusé par le centre de paiement.`;
}

/** Entrés au suivi : chacun reçoit son dossier Drive, l'un après l'autre, en arrière-plan. */
export async function synchroniserLesDossiersDrive(ouverts: { id: string }[], acteurId: string): Promise<void> {
  for (const p of ouverts) {
    await synchroniserDossierDrive(p.id, acteurId)
      .catch((e) => console.error("[drive regulatory] dossier Drive non synchronisé (non bloquant)", { id: p.id }, e));
  }
}
