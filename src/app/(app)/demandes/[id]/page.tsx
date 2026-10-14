import { suppressionPermise } from "@/lib/suppression/delegation";
import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, XCircle, Clock, RotateCcw, MinusCircle, Check, FileText } from "lucide-react";
import { lireCircuit, libelleDuMode, type EtatEtape } from "@/lib/validations/lecture-circuit";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView, hasRole, isTopManagement } from "@/lib/rbac";
import { clauseDemandeLisible } from "@/lib/queries/admin-requests";
import { chargerPiecesLiees, type LignePiece } from "@/lib/queries/chaine-des-pieces";
import { faitsDesDemandes } from "@/lib/queries/demandes-tableau";
import { prisma } from "@/lib/prisma";
import { fieldLabels, REQUEST_TYPE_FIELDS } from "@/lib/admin-requests";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import type { CommentItem } from "@/components/shared/comment-thread";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { LignePieceRow } from "@/components/shared/linked-records";
import { AttachmentValidationBlock } from "./attachment-validation";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { ADMIN_REQUEST_TYPE, ADMIN_REQUEST_STATUS, ADMIN_APPROVAL_STATUS, DRIVER_MISSION_STATUS, PRIORITY, AUDIT_ACTION, VALIDATION_STATUS } from "@/lib/labels";
import { formatDate, formatDateTime, formatCurrency, toNumber, cn } from "@/lib/utils";
import { GestesEnTete } from "./request-actions";
import { refusFinApresDecision } from "@/lib/secretariat/traitement";
import { RequesterWindow } from "./requester-window";
import { FilDemande } from "./fil-demande";
import { CarteDevis, BcAGenerer, AjouterPiece, type DevisVue } from "./devis-natif";
import { ApprovalButtons } from "../approval-buttons";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { ReminderButton } from "@/components/reminders/reminder-button";
import { PromoActionPanel } from "../../promo-material/[id]/promo-panels";
import { BackLink } from "@/components/shared/back-link";
import { siegeAuCentreAdPro } from "@/lib/ad-pro/centre";
import { statutDuDossier } from "@/lib/promo-material/statut";
import { lireLignesDAchat } from "@/lib/general-means/purchase-request";
import { auNomDeQui } from "@/lib/hr/stand-in-resolve";
import { PurchaseLines } from "@/components/purchase/purchase-lines";
import { ficheAFacture } from "@/lib/finance/facture-ordre";
import { dejaPorteParSaFiche } from "@/lib/ad-pro/unified";
import { LIBELLE_ETAT_BC } from "@/lib/bons-de-commande/regle";
import { porteDuDemandeur, refusDeModification, suitLaDemandeDeBcDuPoste, refusDemandeDeBcDuPoste } from "@/lib/secretariat/porte-demandeur";
import { decideurAffiche, libelleMotif, interditSurSaPropreDemande } from "@/lib/secretariat/decision-approbation";
import { statutAffiche, lireParticipants } from "@/lib/secretariat/traitement";
import { chezQuiDeLaDemande, enRetard, friseDeLaDemande, gesteSuivant, lignesDeMontant, FAITS_VIDES, type EtapeFrise } from "@/lib/secretariat/bureau";
import { grouperLesPieces, VIDE_GROUPE, type NatureAjout } from "@/lib/secretariat/pieces";
import { separerLeFil } from "@/lib/secretariat/fil-demande";
import { LIBELLE_BC_DEMANDE, TON_BC_DEMANDE } from "@/lib/secretariat/devis-natif";
import { devisDeLaDemande } from "@/lib/secretariat/devis-natif-serveur";
import { gereLaDemande, commandeLaDemande } from "@/lib/secretariat/droits";
import { pieceEmise, valeursComposables, type ValeursComposables } from "@/lib/legal/piece-emise";
import { papeterieDeLaSociete } from "@/lib/queries/letterheads";
import { ReviserPieceButton } from "@/components/legal/reviser-piece";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FICHE D'UNE DEMANDE AU SECRÉTARIAT (maquette validée, 10/2026) — « chaque information a UN
 * seul endroit ».
 *
 *   • EN TÊTE : badges, titre, « chez qui », et le GESTE SUIVANT (`gesteSuivant`) + « ⋯ » ; la
 *     fenêtre du demandeur (corriger, annuler) ; la frise Déposée → Validée → Traitement →
 *     Paiement → Terminée, calculée de l'état (`friseDeLaDemande`).
 *   • « La demande » : ce qui a été demandé.
 *   • « Pièces » : UNE liste rangée Devis → Bon de commande → Facture → Justificatifs, qui fusionne
 *     les fichiers de la demande, le registre Legal (et ses fichiers) et le dossier de matériel
 *     promotionnel (`grouperLesPieces`) ; les devis y sont NATIFS (lignes retenues par le demandeur)
 *     et le BC généré y montre son étape, relue à la source (`etatsDesBC`).
 *   • « Montant » : une ligne par étape (`lignesDeMontant`).
 *   • « Validations » : UNE carte — l'accord du N+1, les validations du bureau central, la porte et
 *     la signature des BC, les validations de pièces.
 *   • « Discussion » / « Historique » : les messages des personnes d'un côté, les traces du système
 *     et le journal de l'autre (`separerLeFil`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function RequestDetailPage({ params }: { params: { id: string } }) {
  const user = await requireModule("ADMIN_REQUESTS");
  // VALIDATEUR D'UNE PIÈCE = ACCÈS À TOUTE LA DEMANDE (`clauseDemandeLisible`, §118.184).
  const req = await prisma.administrativeRequest.findFirst({
    where: await clauseDemandeLisible(user, params.id),
    include: {
      requester: { select: { name: true, employee: { select: { departmentId: true } } } },
      concerned: { select: { name: true } },
      assignedTo: { select: { name: true } },
      validator: { select: { name: true } },
      department: { select: { name: true } },
      approvals: { include: { validator: { select: { name: true } }, decidedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" } },
      missions: { include: { assignedTo: { select: { name: true } } }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!req) notFound();

  const departments = await prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  // Ce qui vient d'Ad & Pro est déjà porté par le budget de l'opération : la même fonction que l'action (§118.150).
  const fromAdPro = dejaPorteParSaFiche(req.linkedEntityType);
  const alreadyImputed = (await prisma.departmentBudgetExpense.count({ where: { adminRequestId: req.id } })) > 0;

  // L'Assistante de Direction tient le bureau du secrétariat : elle gère et modère toute demande.
  const isSecretary = hasRole(user, "DIRECTION_ASSISTANT");
  const canManage = gereLaDemande(user, req);
  const commande = commandeLaDemande(user, req);
  const estDemandeur = req.requesterId === user.id;
  // Trancher une approbation : le validateur nommé, son intérimaire ou le sommet — la règle de `decideApproval`.
  const canValidate = isTopManagement(user);
  // L'INTÉRIMAIRE tranche l'approbation adressée à l'absent — la même règle que l'action (I18).
  const auNomInterim = await auNomDeQui(user.id);
  const canUpload = userCan(user, "ADMIN_REQUESTS", "UPLOAD") || isSecretary;
  // CE QUE LE DEMANDEUR PEUT ENCORE FAIRE (§118.187) : la règle de l'action, lue ici.
  const porteDemandeur = req.deletedAt || suitLaDemandeDeBcDuPoste(req) ? null : porteDuDemandeur(req, user.id, Date.now());
  const ordresEmis = await prisma.expenseOrder.count({ where: { sourceType: "ADMIN_REQUEST", sourceId: req.id, status: { not: "CANCELLED" } } });

  const [documents, comments, users, linkedValidations, siblings, promo, lu, pieces, faitsMap, idsPieces] = await Promise.all([
    prisma.document.findMany({ where: { entityType: "ADMIN_REQUEST", entityId: req.id }, include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.comment.findMany({ where: { entityType: "ADMIN_REQUEST", entityId: req.id }, include: { author: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    canManage || estDemandeur ? prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([] as { id: string; name: string }[]),
    prisma.validationRequest.findMany({ where: { entityType: "ADMIN_REQUEST", entityId: req.id }, include: { steps: { include: { validator: { select: { name: true } } }, orderBy: { order: "asc" } } }, orderBy: { createdAt: "desc" } }),
    req.batchId ? prisma.administrativeRequest.findMany({ where: { batchId: req.batchId, deletedAt: null }, select: { id: true, reference: true, title: true, status: true, type: true, blockedReason: true }, orderBy: { createdAt: "asc" } }) : Promise.resolve([] as { id: string; reference: string; title: string; status: string; type: string; blockedReason: string | null }[]),
    prisma.promoMaterial.findFirst({ where: { adminRequestId: req.id } }),
    devisDeLaDemande(req.id),
    chargerPiecesLiees({ entityType: "ADMIN_REQUEST", entityId: req.id, canCreate: false, spectateur: user, courriers: false }),
    faitsDesDemandes([{ id: req.id, fields: req.fields }]),
    prisma.legalDocument.findMany({ where: { sourceType: "ADMIN_REQUEST", sourceId: req.id }, select: { id: true } }),
  ]);
  const journal = await prisma.auditLog.findMany({
    where: { OR: [{ entityType: "ADMIN_REQUEST", entityId: req.id }, ...(idsPieces.length ? [{ entityType: "LEGAL_DOCUMENT" as const, entityId: { in: idsPieces.map((p) => p.id) } }] : [])] },
    orderBy: { createdAt: "desc" }, take: 60, include: { actor: { select: { name: true } } },
  });

  // Dossier Matériel promotionnel lié : ses pièces rejoignent « Pièces » ; un dossier d'avant le circuit garde ses gestes.
  const isPromoAssistant = hasGlobalView(user.role) || isSecretary;
  const promoDocs = promo
    ? await prisma.document.findMany({ where: { entityType: "PROMO_MATERIAL", entityId: promo.id }, include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" } })
    : [];
  const promoAmount = promo ? (promo.chosenAmount != null ? toNumber(promo.chosenAmount) : promo.amount != null ? toNumber(promo.amount) : null) : null;
  const promoStatut = promo ? statutDuDossier(promo) : null;
  const promoACircuit = Boolean(promo?.circuitState);

  const modificationFermee = porteDemandeur?.ok
    ? refusDeModification({
        validationEnCours: linkedValidations.some((v) => v.status === "PENDING" && !v.documentId) || req.approvals.some((a) => a.status === "PENDING"),
        paiementEmis: ordresEmis > 0,
      })
    : null;

  // ─── L'état, lu une fois pour l'en-tête, la frise et « chez qui » ───
  const statut = statutAffiche(req.status, req.blockedReason);
  const faits = faitsMap.get(req.id);
  const chez = chezQuiDeLaDemande({
    statut, responsable: req.assignedTo?.name ?? null, demandeur: req.requester?.name ?? null,
    validateurEnAttente: req.approvals.find((a) => a.status === "PENDING")?.validator?.name
      ?? linkedValidations.find((v) => v.status === "PENDING" && !v.documentId)?.steps.find((s) => s.status === "PENDING")?.validator?.name ?? null,
    bc: faits?.bc ?? null, devisARetenir: faits?.devisARetenir ?? false,
  });
  const maintenant = Date.now();
  const retard = enRetard({ statut, echeance: req.deadline ? req.deadline.toISOString() : null }, maintenant);
  const commencee = req.processingStartedAt !== null;
  const geste = gesteSuivant({ statut, commencee, gere: canManage, estDemandeur });
  const frise = friseDeLaDemande({
    statut, commencee,
    approbations: req.approvals.map((a) => ({ status: a.status, decideur: a.decidedBy?.name ?? a.validator?.name ?? null, le: a.decidedAt ? formatDate(a.decidedAt, { day: "2-digit", month: "2-digit" }) : null })),
    validationEnAttente: linkedValidations.some((v) => v.status === "PENDING" && !v.documentId),
    ordreEmis: ordresEmis > 0,
    demandeur: req.requester?.name ?? null,
    deposeeLe: formatDate(req.createdAt, { day: "2-digit", month: "2-digit" }),
    responsable: req.assignedTo?.name ?? null,
  });
  const ouverte = statut !== "DONE" && statut !== "CANCELLED";
  const factureManquante = req.type === "PURCHASE" && !(await ficheAFacture({ entityType: "ADMIN_REQUEST", entityId: req.id }));

  const participantIds = lireParticipants(req.fields);
  const participants = participantIds.length
    ? (await prisma.user.findMany({ where: { id: { in: participantIds } }, select: { name: true }, orderBy: { name: "asc" } })).map((u) => u.name)
    : [];
  const labels = fieldLabels(req.type);
  const fields = (req.fields as Record<string, unknown> | null) ?? {};
  const fieldEntries = Object.entries(labels).filter(([k]) => fields[k] !== undefined && fields[k] !== "");
  // Les articles d'une demande d'achat vivent dans `fields.purchaseLines`, hors des champs déclarés du type (I14).
  const lignesAchat = req.type === "PURCHASE" ? lireLignesDAchat(fields) : [];

  const asDoc = (d: (typeof documents)[number]): DocItem => ({ id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes, confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null, createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey) });
  const docItems = documents.map(asDoc);
  const promoDocItems = promoDocs.map(asDoc);

  // ─── Les pièces : trois sources, une liste ───
  const etatBC = new Map(lu.bcs.map((b) => [b.id, b]));
  const bcRegistre: LignePiece[] = pieces.sections.PURCHASE_ORDER.map((l) => {
    const e = etatBC.get(l.id);
    return e && !e.annule ? { ...l, badge: { label: LIBELLE_BC_DEMANDE[e.etape], tone: TON_BC_DEMANDE[e.etape] } } : l;
  });
  // Les devis se rendent NATIFS (leurs lignes) : la ligne du registre ne se montre pas une seconde fois.
  const groupes = grouperLesPieces<LignePiece, DocItem>({
    registre: { PURCHASE_ORDER: bcRegistre, INVOICE: pieces.sections.INVOICE, ENGAGEMENT: pieces.sections.ENGAGEMENT },
    fichiersDemande: docItems,
    fichiersDossier: promoDocItems,
  });
  const refBC = Object.fromEntries(lu.bcs.filter((b) => !b.annule).map((b) => [b.id, b.reference?.trim() || "BC sans numéro"]));
  const devisVues: DevisVue[] = lu.devis.map((d) => ({
    id: d.id, reference: d.reference, titre: d.titre, annule: d.annule, fournisseur: d.natif.fournisseur, fournisseurId: d.natif.fournisseurId,
    date: d.natif.date, lignes: d.natif.lignes, fichier: d.fichier, bcs: refBC,
  }));
  const natures: NatureAjout[] = ouverte
    ? [...(canManage ? ["DEVIS" as const] : []), ...(canManage || commande ? ["BC" as const] : []), ...(canUpload ? ["FACTURE" as const, "JUSTIFICATIF" as const] : [])]
    : [];
  const nbPieces = lu.devis.length + groupes.reduce((s, g) => s + g.elements.length, 0);

  // ─── Le fil ───
  const fil = separerLeFil(
    comments.map((c) => ({ id: c.id, body: c.body, authorId: c.authorId, createdAt: c.createdAt.toISOString(), auteur: c.author?.name ?? null, editedAt: c.editedAt?.toISOString() ?? null })),
    journal.map((h) => ({ id: h.id, le: h.createdAt.toISOString(), texte: h.summary ?? `${AUDIT_ACTION[h.action]?.label ?? h.action}${h.field ? ` — ${h.field}` : ""}`, par: h.actor?.name ?? null })),
  );
  const discussion: CommentItem[] = fil.discussion.map((c) => ({ id: c.id, author: c.auteur ?? "Utilisateur", authorId: c.authorId, body: c.body, createdAt: c.createdAt, editedAt: c.editedAt }));

  const dernierAccord = req.approvals.find((a) => a.status === "APPROVED" && a.amount);
  const lignesMontant = lignesDeMontant(faits?.faits ?? FAITS_VIDES, {
    estimePar: req.requester?.name ?? null,
    validePar: dernierAccord ? `${dernierAccord.decidedBy?.name ?? dernierAccord.validator?.name ?? "le validateur"}${dernierAccord.decidedAt ? ` le ${formatDate(dernierAccord.decidedAt)}` : ""}` : null,
    bcs: lu.bcs.filter((b) => !b.annule).map((b) => b.reference ?? b.title).join(", ") || null,
  });
  const centralesHorsPieces = linkedValidations.filter((v) => !v.documentId);
  const bcVivants = lu.bcs.filter((b) => !b.annule);
  // « MODIFIER LE BC » DEPUIS LA DEMANDE (Direction, 14/10/2026) — un BC émis par la fabrique, non signé, d'une demande ouverte :
  // le demandeur (ou qui gère la demande) le révise de A à Z dans le composeur, sans passer par Legal ni l'annuler
  // (`reviserPieceCommerciale`, sous la délégation de la demande — `secretariat/delegation-bc.ts`).
  const bcsRevisables = ouverte && (commande || canManage) ? bcVivants.filter((b) => b.etape !== "SIGNE" && !b.signeLe) : [];
  const revisions = new Map<string, { numero: string; version: number; valeurs: ValeursComposables }>();
  let societeDesBCId: string | null = null;
  if (bcsRevisables.length > 0) {
    const docs = await prisma.legalDocument.findMany({ where: { id: { in: bcsRevisables.map((b) => b.id) }, signedAt: null }, select: { id: true, custom: true, companyId: true } });
    for (const d of docs) {
      const emise = pieceEmise(d.custom);
      const valeurs = emise ? valeursComposables(d.custom) : null;
      if (emise && valeurs && emise.type === "BON_DE_COMMANDE") {
        revisions.set(d.id, { numero: emise.numero, version: emise.version, valeurs });
        societeDesBCId ??= d.companyId;
      }
    }
  }
  const societeDesBC = societeDesBCId ? await prisma.company.findUnique({ where: { id: societeDesBCId }, select: { id: true, name: true, shortName: true } }) : null;
  const papeterieDesBC = societeDesBC ? await papeterieDeLaSociete(societeDesBC.id) : [];
  const aucuneValidation = req.approvals.length === 0 && centralesHorsPieces.length === 0 && bcVivants.length === 0;

  return (
    <div className="space-y-4">
      <BackLink href="/demandes"><ArrowLeft className="h-4 w-4" /> Retour au tableau</BackLink>

      {/* ─────────── En tête ─────────── */}
      <section className="surface grid gap-3 rounded-xl p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="grid min-w-0 gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs text-muted-foreground">{req.reference}</span>
              <Badge tone="neutral" dot={false}>{ADMIN_REQUEST_TYPE[req.type] ?? req.type}</Badge>
              <StatusBadge map={PRIORITY} value={req.priority} dot={false} />
              <StatusBadge map={ADMIN_REQUEST_STATUS} value={statut} />
            </div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{req.title}</h1>
            <p className="text-xs text-muted-foreground">
              {chez ? <>Chez <strong className="text-foreground">{chez.etape}</strong>{chez.personne ? ` — ${chez.personne}` : ""}</> : statut === "CANCELLED" ? "Demande annulée." : "Demande close."}
              {req.deadline && <> · échéance {formatDate(req.deadline)}</>}
              {retard && <> · <span className="font-semibold text-destructive">en retard</span></>}
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-2 lg:justify-end">
            <GestesEnTete
              requestId={req.id} status={statut} type={req.type} geste={geste} gere={canManage} commencee={commencee}
              peutRelancer={ouverte && (estDemandeur || canManage)}
              departments={departments} defaultDepartmentId={req.departmentId ?? req.requester?.employee?.departmentId ?? null}
              fromAdPro={fromAdPro} alreadyImputed={alreadyImputed} factureManquante={factureManquante}
              refusAnnulation={suitLaDemandeDeBcDuPoste(req) ? refusDemandeDeBcDuPoste("annuler") : null}
              refusFin={refusFinApresDecision(req.approvals[0] ?? null)}
              users={users} assignedToId={req.assignedToId}
            />
            <ReminderButton defaultTitle={`Demande ${req.reference} — ${req.title}`} link={`/demandes/${req.id}`} entityType="ADMIN_REQUEST" entityId={req.id} />
            <SuperAdminDeleteButton kind="ADMIN_REQUEST" id={req.id} name={`${req.reference} — ${req.title}`} enabled={suppressionPermise(user, "ADMIN_REQUEST")} />
          </div>
        </div>

        {porteDemandeur?.ok && (
          <RequesterWindow
            requestId={req.id}
            createdAt={req.createdAt.toISOString()}
            discret={porteDemandeur.discret}
            modificationFermee={modificationFermee}
            values={{
              title: req.title,
              description: req.description,
              priority: req.priority,
              deadline: req.deadline ? req.deadline.toISOString().slice(0, 10) : null,
              fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v == null ? "" : String(v)])),
            }}
            // `parties` porte aussi des `options`, mais ce sont des contacts d'annuaire : les demandes administratives n'en ont pas.
            typeFields={(REQUEST_TYPE_FIELDS[req.type] ?? []).map((f) => ({ type: f.type, name: f.name, label: f.label, full: f.full, options: "options" in f && f.type !== "parties" ? f.options : undefined }))}
          />
        )}

        <Frise etapes={frise} />
      </section>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-4">
          {/* ─────────── La demande ─────────── */}
          <section className="surface rounded-xl">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">La demande</h2>
              <span className="text-xs text-muted-foreground">créée le {formatDate(req.createdAt)}{req.requester?.name ? ` par ${req.requester.name}` : ""}</span>
            </header>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <Info label="Demandeur" value={req.requester?.name ? `${req.requester.name}${req.department?.name ? ` (${req.department.name})` : ""}` : null} />
              <Info label="Responsable" value={req.assignedTo?.name ?? "non attribuée"} />
              {req.validator?.name && <Info label="Validateur" value={req.validator.name} />}
              {req.concerned?.name && <Info label="Personne concernée" value={req.concerned.name} />}
              {participants.length > 0 && <Info label="Participants" value={participants.join(", ")} />}
              <Info label="Échéance" value={req.deadline ? formatDate(req.deadline) : null} />
              <Info label="Créée le" value={formatDateTime(req.createdAt)} />
              {fieldEntries.map(([k, label]) => <Info key={k} label={label} value={String(fields[k])} />)}
              {req.description && <div className="sm:col-span-2 lg:col-span-3"><dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Description</dt><dd className="mt-0.5 whitespace-pre-line break-words">{req.description}</dd></div>}
              {req.blockedReason && <div className="sm:col-span-2 lg:col-span-3"><dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Motif de blocage</dt><dd className="mt-0.5 font-medium text-destructive">{req.blockedReason}</dd></div>}
            </dl>
            {lignesAchat.length > 0 && (
              <div className="border-t border-border p-4">
                <p className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Articles demandés ({lignesAchat.length})</p>
                <PurchaseLines lines={lignesAchat} />
              </div>
            )}
            {siblings.length > 1 && (
              <div className="border-t border-border p-4 text-sm">
                <p className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Demande groupée ({siblings.length} cellules)</p>
                {siblings.map((s) => (
                  <Link key={s.id} href={`/demandes/${s.id}`} className={cn("flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-secondary", s.id === req.id && "bg-secondary font-medium")}>
                    <span className="min-w-0 truncate"><span className="font-mono text-xs text-muted-foreground">{s.reference}</span> — {s.title}</span>
                    <StatusBadge map={ADMIN_REQUEST_STATUS} value={statutAffiche(s.status, s.blockedReason)} dot={false} />
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* ─────────── Pièces ─────────── */}
          <section className="surface rounded-xl">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Pièces <span className="font-normal text-muted-foreground">({nbPieces})</span></h2>
              <AjouterPiece requestId={req.id} natures={natures} devis={lu.devis.filter((d) => !d.annule).map((d) => ({ id: d.id, libelle: `${d.natif.fournisseur || d.titre}${d.reference ? ` — n° ${d.reference}` : ""}` }))} />
            </header>
            <div className="grid gap-5 p-4">
              {groupes.map((g) => {
                const devisDuGroupe = g.cle === "DEVIS" ? devisVues : [];
                const vide = g.elements.length === 0 && devisDuGroupe.length === 0;
                return (
                  <div key={g.cle} className="grid gap-2">
                    <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">{g.titre}</h3>
                    {g.cle === "BC" && ouverte && (
                      <BcAGenerer requestId={req.id} peutGenerer={commande}
                        groupes={lu.aGenerer.map((x) => ({ cle: x.cle, fournisseur: x.fournisseur, nbLignes: x.lignes.length, ttc: x.totaux.ttc, devis: x.devis.map((d) => (d.reference ? `devis n° ${d.reference}` : "devis")) }))} />
                    )}
                    {devisDuGroupe.map((d) => (
                      <CarteDevis key={d.id} requestId={req.id} d={d} peutRetranscrire={canManage && ouverte} peutRetenir={commande && ouverte} />
                    ))}
                    {g.elements.some((e) => e.source === "REGISTRE") && (
                      <ul className="divide-y divide-border rounded-xl border border-border px-3">
                        {g.elements.map((e) => {
                          if (e.source !== "REGISTRE") return null;
                          const bc = etatBC.get(e.piece.id);
                          return (
                            <Fragment key={e.piece.id}>
                              <LignePieceRow l={e.piece} />
                              {bc && !bc.annule && <li className="list-none border-t-0"><NoteBC bc={bc} /></li>}
                              {revisions.has(e.piece.id) && (
                                <li className="list-none border-t-0 pb-2 pl-3 text-xs">
                                  <ReviserPieceButton
                                    discret libelle="Modifier le BC" legalDocumentId={e.piece.id} type="BON_DE_COMMANDE"
                                    numero={revisions.get(e.piece.id)!.numero} version={revisions.get(e.piece.id)!.version} valeurs={revisions.get(e.piece.id)!.valeurs}
                                    societe={societeDesBC ? { id: societeDesBC.id, label: societeDesBC.shortName || societeDesBC.name } : null}
                                    letterheads={papeterieDesBC}
                                  />
                                </li>
                              )}
                            </Fragment>
                          );
                        })}
                      </ul>
                    )}
                    {g.elements.some((e) => e.source === "FICHIER" && e.origine === "DEMANDE") && (
                      <DocumentList
                        documents={g.elements.flatMap((e) => (e.source === "FICHIER" && e.origine === "DEMANDE" ? [e.fichier] : []))}
                        canDelete={canManage} canEdit={onlyofficeConfigured() && canUpload} path={`/demandes/${req.id}`}
                      />
                    )}
                    {g.elements.some((e) => e.source === "FICHIER" && e.origine === "DOSSIER") && (
                      <div className="grid gap-1">
                        <p className="text-xs text-muted-foreground">Du dossier de matériel promotionnel {promo?.reference}</p>
                        <DocumentList
                          documents={g.elements.flatMap((e) => (e.source === "FICHIER" && e.origine === "DOSSIER" ? [e.fichier] : []))}
                          canDelete={isPromoAssistant && !promoACircuit} canEdit={onlyofficeConfigured() && isPromoAssistant} path={`/demandes/${req.id}`}
                        />
                      </div>
                    )}
                    {vide && <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">{VIDE_GROUPE[g.cle]}</p>}
                  </div>
                );
              })}
            </div>
          </section>

          <FilDemande requestId={req.id} discussion={discussion} historique={fil.historique} currentUserId={user.id} canModerate={canManage} />
        </div>

        <div className="grid min-w-0 gap-4">
          {/* ─────────── Montant ─────────── */}
          <section className="surface rounded-xl">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Montant</h2>
              <span className="text-xs text-muted-foreground">une ligne par étape</span>
            </header>
            <div className="divide-y divide-border px-4">
              {lignesMontant.map((l) => (
                <div key={l.cle} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-2.5">
                  <div className="min-w-0"><p className="text-sm">{l.libelle}</p><p className="text-xs text-muted-foreground">{l.detail}</p></div>
                  <span className={cn("text-sm font-bold tabular-nums", l.montant == null && "font-normal text-muted-foreground")}>{l.montant != null ? formatCurrency(l.montant) : "—"}</span>
                </div>
              ))}
            </div>
          </section>

          {/* ─────────── Validations ─────────── */}
          <section className="surface rounded-xl">
            <header className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">Validations</h2></header>
            <div className="grid gap-3 p-4 text-sm">
              {aucuneValidation && <p className="text-muted-foreground">Aucune validation demandée.</p>}
              {req.approvals.map((a) => {
                const decideur = decideurAffiche({ status: a.status, decidedAt: a.decidedAt, decidedByName: a.decidedBy?.name ?? null });
                return (
                  <div key={a.id} className="grid gap-1 border-b border-border pb-2.5 last:border-0 last:pb-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">Validation de la demande</span>
                      <StatusBadge map={ADMIN_APPROVAL_STATUS} value={a.status} dot={false} />
                    </div>
                    <p className="text-xs text-muted-foreground">{a.validator?.name ?? "—"}{a.amount ? ` · ${formatCurrency(toNumber(a.amount))}` : ""}{decideur ? ` · ${decideur}` : ""}{a.decidedAt ? ` le ${formatDateTime(a.decidedAt)}` : ""}</p>
                    {a.comment && <p className="text-xs">{a.comment}</p>}
                    {a.decisionNote && <p className="text-xs"><span className="text-muted-foreground">{libelleMotif(a.status)} :</span> « {a.decisionNote} »</p>}
                    {/* Un bouton que l'action refuserait n'est pas un geste (§118.83) : on ne tranche pas sa propre demande. */}
                    {a.status === "PENDING" && (canValidate || a.validatorId === user.id
                      || (req.requesterId !== user.id && auNomInterim.nomDe(a.validatorId) !== null))
                      && !interditSurSaPropreDemande({ estDemandeur: req.requesterId === user.id, sommet: isTopManagement(user) })
                      && <ApprovalButtons approvalId={a.id} />}
                  </div>
                );
              })}
              {centralesHorsPieces.map((v) => {
                const circuit = lireCircuit({
                  status: v.status, mode: v.mode, currentOrder: v.currentOrder,
                  steps: v.steps.map((s) => ({ order: s.order, status: s.status, validateur: s.validator?.name ?? "—", motif: s.reason, decideeLe: s.decidedAt })),
                });
                return (
                  <div key={v.id} className="grid gap-1 border-b border-border pb-2.5 last:border-0 last:pb-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link href={`/validations/${v.id}`} className="font-semibold hover:underline">{v.module} <span className="font-mono text-xs font-normal text-muted-foreground">{v.reference}</span></Link>
                      <StatusBadge map={VALIDATION_STATUS} value={v.status} dot={false} />
                    </div>
                    <p className="text-xs text-muted-foreground">{circuit.resume}{libelleDuMode(v.mode, v.steps.length) ? ` · ${libelleDuMode(v.mode, v.steps.length)}` : ""}</p>
                    <ul className="grid gap-1">
                      {circuit.lignes.map((l, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-xs">
                          <IconeEtape etat={l.etat} />
                          <span className="min-w-0"><span className="font-medium">{l.validateur}</span><span className="text-muted-foreground"> — {l.libelle}{l.decideeLe ? ` le ${formatDateTime(l.decideeLe)}` : ""}</span>{l.motif && <span className="block">« {l.motif} »</span>}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
              {bcVivants.map((b) => (
                <div key={b.id} className="grid gap-1 border-b border-border pb-2.5 last:border-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">Bon de commande {b.reference ?? ""}</span>
                    <Badge tone={TON_BC_DEMANDE[b.etape]} dot={false}>{LIBELLE_BC_DEMANDE[b.etape]}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Centre de validations : {b.porte ? LIBELLE_ETAT_BC[b.porte.etat].toLowerCase() : b.validationRequise ? "pas encore adressé" : `non requis (sous le seuil de ${b.seuil.toLocaleString("fr-FR")} DZD)`}
                    {" · "}Signature : {b.signeLe ? `signé${b.signePar ? ` par ${b.signePar.name}` : ""} le ${formatDate(b.signeLe)}` : b.etape === "A_SIGNER" ? "attendue (module Bons de commande)" : "—"}
                  </p>
                </div>
              ))}
              <AttachmentValidationBlock
                requestId={req.id}
                documents={documents.map((d) => ({ id: d.id, name: d.name }))}
                validations={linkedValidations.filter((v) => v.documentId).map((v) => ({
                  id: v.id, reference: v.reference, documentId: v.documentId!, status: v.status, createdAt: v.createdAt.toISOString(),
                  steps: v.steps.map((st) => ({ validator: st.validator?.name ?? "?", status: st.status })),
                }))}
                users={users}
                canSubmit={canManage || estDemandeur}
              />
            </div>
          </section>

          {req.missions.length > 0 && (
            <section className="surface rounded-xl">
              <header className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">Missions chauffeur</h2></header>
              <div className="grid gap-2 p-4 text-sm">
                {req.missions.map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0"><span className="block truncate font-medium">{m.title}</span><span className="text-xs text-muted-foreground">{m.assignedTo?.name ?? "Non assignée"}</span></span>
                    <StatusBadge map={DRIVER_MISSION_STATUS} value={m.status} dot={false} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {promo && (
            <section className="surface rounded-xl">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">Matériel promotionnel</h2>
                {promoStatut && <Badge tone={promoStatut.ton} dot={false}>{promoStatut.libelle}</Badge>}
              </header>
              <div className="grid gap-3 p-4 text-sm">
                <p className="text-xs text-muted-foreground">
                  {promo.chosenAgency ? `Agence retenue : ${promo.chosenAgency} · ` : ""}{promoAmount != null ? `${formatCurrency(promoAmount)} · ` : ""}
                  <Link href={`/promo-material/${promo.id}`} className="font-medium text-primary hover:underline">ouvrir {promo.reference}</Link>
                  {" "}— ses pièces sont rangées dans « Pièces ».
                </p>
                {isPromoAssistant && !promoACircuit && (
                  <PromoActionPanel
                    id={promo.id}
                    status={promo.status}
                    flags={{ isMarketing: false, isAssistant: true, isFinance: false, isMedicalInfo: false, isDirection: hasGlobalView(user.role), isCentreAdPro: siegeAuCentreAdPro(user) }}
                    chosenAgency={promo.chosenAgency}
                    bcReference={promo.bcReference}
                    visaReference={promo.visaReference}
                    authorityRef={promo.authorityRef}
                    amount={promoAmount}
                    reminderCount={promo.financeReminderCount}
                  />
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** LA FRISE — cinq étapes, calculées de l'état ; une étape « sans objet » se lit en pointillé. */
function Frise({ etapes }: { etapes: EtapeFrise[] }) {
  return (
    <ol aria-label="Avancement" className="grid grid-cols-5 pt-1">
      {etapes.map((e, i) => {
        const faite = e.etat === "FAITE";
        const courante = e.etat === "COURANTE";
        const refusee = e.etat === "REFUSEE";
        return (
          <li key={e.cle} className="relative grid justify-items-center gap-1 px-0.5 text-center">
            {i > 0 && <span aria-hidden className={cn("absolute left-[-50%] right-1/2 top-[11px] h-0.5", faite || courante ? "bg-success" : "bg-border")} />}
            <span className={cn(
              "relative z-[1] grid h-[22px] w-[22px] place-items-center rounded-full border-2 bg-card text-[0.6875rem] font-bold text-muted-foreground",
              faite && "border-success bg-success text-success-foreground",
              courante && "border-primary text-primary ring-4 ring-primary/15",
              refusee && "border-destructive bg-destructive text-destructive-foreground",
              e.etat === "SANS_OBJET" && "border-dashed",
            )}>
              {faite ? <Check className="h-3 w-3" /> : refusee ? <XCircle className="h-3 w-3" /> : e.etat === "SANS_OBJET" ? "–" : i + 1}
            </span>
            <span className={cn("text-[0.6875rem] font-semibold sm:text-xs", e.etat === "SANS_OBJET" && "text-muted-foreground")}>{e.libelle}</span>
            {e.detail && <span className="hidden max-w-full truncate text-[0.6875rem] text-muted-foreground sm:block">{e.detail}</span>}
            <span className="sr-only">{e.etat === "FAITE" ? "faite" : e.etat === "COURANTE" ? "en cours" : e.etat === "REFUSEE" ? "refusée" : e.etat === "SANS_OBJET" ? "sans objet" : "à venir"}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Sous un BC : le motif du centre ou du signataire, et la signature — lus sur l'état, jamais recopiés. */
function NoteBC({ bc }: { bc: { etape: string; porte: { note?: string | null } | null; renvoi: { note: string | null; par: string | null } | null; signeLe: Date | null; signePar: { name: string } | null } }) {
  if (bc.etape === "SIGNE" && bc.signeLe) return <p className="pb-2 pl-3 text-xs text-success"><CheckCircle2 className="mr-1 inline h-3 w-3" />Signé{bc.signePar ? ` par ${bc.signePar.name}` : ""} le {formatDate(bc.signeLe)} — validé et signé.</p>;
  if ((bc.etape === "REFUSE" || bc.etape === "A_REVOIR") && bc.porte?.note) return <p className="pb-2 pl-3 text-xs text-destructive">Motif du centre : « {bc.porte.note} »</p>;
  if (bc.etape === "A_CORRIGER" && bc.renvoi) return <p className="pb-2 pl-3 text-xs text-warning">Renvoyé{bc.renvoi.par ? ` par ${bc.renvoi.par}` : ""}{bc.renvoi.note ? ` : « ${bc.renvoi.note} »` : ""}</p>;
  if (bc.etape === "A_SIGNER") return <p className="pb-2 pl-3 text-xs text-muted-foreground"><FileText className="mr-1 inline h-3 w-3" />Validé — il attend sa signature dans le module Bons de commande.</p>;
  return null;
}

/** ✓ validé · ✗ refusé · ↺ correction demandée · ⏳ en attente · — non sollicité. */
function IconeEtape({ etat }: { etat: EtatEtape }) {
  const cls = "mt-0.5 h-3.5 w-3.5 shrink-0";
  if (etat === "VALIDE") return <CheckCircle2 className={cn(cls, "text-success")} aria-label="Validé" />;
  if (etat === "REFUSE") return <XCircle className={cn(cls, "text-destructive")} aria-label="Refusé" />;
  if (etat === "A_CORRIGER") return <RotateCcw className={cn(cls, "text-amber-600")} aria-label="Correction demandée" />;
  if (etat === "SANS_OBJET") return <MinusCircle className={cn(cls, "text-muted-foreground")} aria-label="Non sollicité" />;
  return <Clock className={cn(cls, etat === "A_SON_TOUR" ? "text-amber-600" : "text-muted-foreground")} aria-label="En attente" />;
}

function Info({ label, value }: { label: string; value: string | null | undefined }) {
  return <div className="min-w-0"><dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt><dd className="mt-0.5 break-words font-medium">{value || "—"}</dd></div>;
}
