import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber, formatCurrency, formatDate } from "@/lib/utils";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { PageHeader } from "@/components/shared/page-header";
import { VisaCentreBanniere } from "@/components/ad-pro/visa-centre-banniere";
import { SupprimerDemandeAdPro } from "@/components/ad-pro/supprimer-demande";
import { peutSupprimerUneDemandeAdPro } from "@/lib/queries/ad-pro-suppression";
import { BackLink } from "@/components/shared/back-link";
import { StatusBadge } from "@/components/shared/status-badge";
import { AD_PRO_DOC_CATEGORIES, categoriesDuDepotDeLaDemande } from "@/lib/ad-pro/doc-categories";
import { canAttachToAdPro, attachHint } from "@/lib/ad-pro/attachments";
import type { DocItem } from "@/components/documents/document-list";
import { AD_PRO_OTHER_STATUS } from "@/lib/labels";
import { OtherDecisionPanel } from "./decision-panel";
import { AdProDiscussionCard } from "@/components/ad-pro/discussion-card";
import { MedecinsConcernes } from "@/components/ad-pro/medecins-concernes";
import { AdProEditButton } from "@/components/ad-pro/edit-request-button";
import { canEditAdProRequest, isAdProDecided } from "@/lib/ad-pro-edit";
import { adProEditValues } from "@/lib/queries/ad-pro-edit";
import { WorkflowPanel } from "@/components/workflow/workflow-panel";
import { getWorkflowForEntity } from "@/lib/queries/workflow";
import { AdProItemsPanel } from "@/components/ad-pro/items-panel";
import { CarteDetailsDemande } from "@/components/ad-pro/pieces-jointes-demande";
import { PiecesLegalDeLaDemande } from "@/components/ad-pro/pieces-legal-demande";
import { Faits, Fait, Repli, IntertitrePostes } from "@/components/ad-pro/carte-demande";
import { loadAdProItems, adProBudgetOptions, contexteMaterielStock, contextePostes } from "@/lib/queries/ad-pro-items";
import { promoMaterialOptions } from "@/lib/actions/ad-pro-item-actions";
import { siegeAuCentreAdPro } from "@/lib/ad-pro/centre";

export const dynamic = "force-dynamic";

/**
 * LA FICHE D'UNE DEMANDE « AUTRE » — une fiche À POSTES depuis le 27/10/2026 (décision #17).
 *
 * Elle suit le circuit commun : la carte « La demande » porte le panneau du circuit (prévalidation par la
 * route de son créateur, renvoi, resoumission, appel), ses faits, ses pièces générales, puis ses POSTES —
 * ajoutés après la prévalidation, acceptés par la Direction Marketing, sous la porte du DG sur leur total.
 * La chaîne d'achat (devis → BC → facture) vit sur chaque poste, comme sur le sponsoring, les prises en
 * charge et les événements : le bloc « Pièces liées » de la demande disparaît (§118.204).
 */
export default async function AdProOtherDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireModule("AD_PRO_OTHER");
  const req = await prisma.adProOtherRequest.findUnique({
    where: { id: params.id },
    include: { company: { select: { name: true } } },
  });
  if (!req) notFound();

  const mine = req.requesterId === user.id || hasGlobalView(user.role);
  const mayDecide = userCan(user, "AD_PRO_OTHER", "VALIDATE");

  // ── LE CIRCUIT COMMUN (27/10/2026, décision #17) ──────────────────────────────────────────────
  // La demande se décide par son circuit, puis vit par ses POSTES et la porte du DG sur leur total.
  // L'instance s'ouvre ici pour une demande née avant la règle, à l'étape que la route de son créateur désigne.
  const canAllocateItems = hasGlobalView(user) || mayDecide;
  const [workflow, items, promoOptions, budgetOptions, contexte, materielStock, documents] = await Promise.all([
    getWorkflowForEntity(user, "AD_PRO_OTHER", req.id, req.requesterId ?? null),
    loadAdProItems("AD_PRO_OTHER", req.id),
    promoMaterialOptions(),
    adProBudgetOptions(user),
    contextePostes(user, "AD_PRO_OTHER", req.id),
    contexteMaterielStock(user, "AD_PRO_OTHER", req.id, canAllocateItems),
    prisma.document.findMany({
      where: { entityType: "AD_PRO_OTHER", entityId: req.id },
      include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" },
    }),
  ]);
  // La ligne se RELIT après l'ouverture éventuelle du circuit : une demande de la Direction Marketing est
  // prévalidée d'office à la naissance de son instance, et sa décision s'écrit à ce moment-là.
  const ligne = (await prisma.adProOtherRequest.findUnique({
    where: { id: req.id }, select: { status: true, decidedById: true, decidedAt: true, decisionNote: true },
  })) ?? req;
  const statut = ligne.status;
  const prevalidee = statut === "APPROVED" || statut === "DONE";
  const open = statut !== "DONE" && statut !== "CANCELLED";

  const people = await prisma.user.findMany({
    where: { id: { in: [req.requesterId, ligne.decidedById].filter((x): x is string => Boolean(x)) } },
    select: { id: true, name: true },
  });
  const names = new Map(people.map((p) => [p.id, p.name]));

  // LES PIÈCES GÉNÉRALES DE LA DEMANDE — la règle commune d'Ad & Pro (`ad-pro/attachments.ts`).
  const attacheur = {
    id: user.id,
    canUploadModule: userCan(user, "AD_PRO_OTHER", "UPLOAD"),
    canUpdateModule: userCan(user, "AD_PRO_OTHER", "UPDATE"),
    canValidateModule: mayDecide,
    hasGlobalView: hasGlobalView(user),
  };
  const dossierAdPro = { requesterId: req.requesterId ?? null, productManagerId: null };
  const canUploadDocs = open && (canAttachToAdPro(attacheur, dossierAdPro) || mine);
  const uploadHint = canUploadDocs ? null : open ? attachHint(attacheur, dossierAdPro) : "La demande est close : on n'y joint plus de pièce.";

  // CORRIGER LA DEMANDE (audit 360°, rapport 17 R14) — la MÊME règle que les autres natures du pôle :
  // son demandeur et qui tranche tant qu'elle attend sa décision, la vue globale toujours.
  const demandeDecidee = isAdProDecided("AD_PRO_OTHER", statut);
  const canEditRequest = canEditAdProRequest(
    { id: user.id, hasGlobalView: hasGlobalView(user.role), canManage: mayDecide },
    { requesterId: req.requesterId, decided: demandeDecidee },
  );
  const editValues = canEditRequest ? await adProEditValues("AD_PRO_OTHER", req.id) : null;

  const docItems: DocItem[] = documents.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));

  return (
    <div className="space-y-5">
      <BackLink href="/ad-pro/autres"><ArrowLeft className="h-4 w-4" /> Autres demandes</BackLink>
      <PageHeader title={req.title} description={`Réf. ${req.reference}`}>
        <StatusBadge map={AD_PRO_OTHER_STATUS} value={statut} />
        {editValues && <AdProEditButton kind="AD_PRO_OTHER" id={req.id} decided={demandeDecidee} values={editValues} />}
        {/* Une nature du pôle qui n'avait AUCUNE suppression (§118.162). */}
        <SupprimerDemandeAdPro kind="AD_PRO_OTHER" id={req.id} name={`${req.reference} — ${req.title}`} enabled={await peutSupprimerUneDemandeAdPro(user, "AD_PRO_OTHER", req.id)} />
      </PageHeader>

      {/* L'ÉTAT DU CENTRE AD & PRO (audit 360°, R07/R10) — pour une demande née avant le 27/10/2026, dont la
          porte du centre a pu rester posée. Les demandes nouvelles n'en ont plus : le DG valide le total des postes. */}
      <VisaCentreBanniere entityType="AD_PRO_OTHER" entityId={req.id} viewer={user} />

      <CarteDetailsDemande
        titre="La demande"
        piecesRepliees
        contentClassName="space-y-3"
        pieces={{
          entityType: "AD_PRO_OTHER", entityId: req.id, documents: docItems,
          peutDeposer: canUploadDocs, motif: uploadHint,
          categories: categoriesDuDepotDeLaDemande(AD_PRO_DOC_CATEGORIES),
          canDelete: userCan(user, "AD_PRO_OTHER", "DELETE") || hasGlobalView(user.role),
          canRename: canUploadDocs, canEdit: onlyofficeConfigured() && canUploadDocs,
          path: `/ad-pro/autres/${req.id}`,
        }}
        entete={
          <div className="space-y-4">
            {/* LE CIRCUIT : prévalidation, avis, renvoi pour correction, resoumission, appel — les mêmes gestes
                que sur le sponsoring, les prises en charge et les événements. */}
            {workflow && <WorkflowPanel entityType="AD_PRO_OTHER" entityId={req.id} view={workflow} compact />}
            <OtherDecisionPanel
              id={req.id}
              status={statut}
              canClose={(mine || mayDecide) && (statut === "APPROVED" || statut === "REFUSED")}
            />

            <Faits>
              <Fait label="Pour qui / avec qui" valeur={req.beneficiary} />
              <Fait label="Montant demandé" valeur={req.amount != null ? formatCurrency(toNumber(req.amount)) : null} />
              <Fait label="Entité" valeur={req.company?.name} />
              <Fait label="Demandeur" valeur={req.requesterId ? names.get(req.requesterId) : null} />
              {ligne.decidedById && <Fait label="Décidée par" valeur={names.get(ligne.decidedById)} />}
              {ligne.decidedAt && <Fait label="Décidée le" valeur={formatDate(ligne.decidedAt.toISOString())} />}
              {req.product && <Fait label="Produits" valeur={req.product} />}
              {req.doctor && <Fait label="Médecins" valeur={req.doctor} />}
              {ligne.decisionNote && <Fait large label="Motif de la décision" valeur={ligne.decisionNote} />}
            </Faits>

            {req.description && (
              <Repli titre="Description">
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{req.description}</p>
              </Repli>
            )}
          </div>
        }
      >
        {/* LES POSTES (27/10/2026) — ajoutés APRÈS la prévalidation par les parties prenantes, acceptés par la
            Direction Marketing (montant et budget) ; le DG valide leur TOTAL au-dessus du seuil (carte en tête). */}
        <IntertitrePostes n={items.length} />
        {!prevalidee && open && (
          <p className="text-sm text-muted-foreground">
            Les postes s&apos;ajoutent après la prévalidation de la Direction Marketing : aucun budget n&apos;est ouvert avant.
          </p>
        )}
        <AdProItemsPanel
          parent="AD_PRO_OTHER"
          parentId={req.id}
          items={items}
          amountGranted={null}
          decided={prevalidee}
          tardif={false}
          fige={statut === "DONE"}
          canEdit={userCan(user, "AD_PRO_OTHER", "CREATE") || userCan(user, "AD_PRO_OTHER", "UPDATE") || canAllocateItems}
          canAllocate={canAllocateItems}
          promoOptions={promoOptions}
          budgetOptions={budgetOptions}
          materiel={materielStock}
          canIssueOrder={userCan(user, "FINANCES", "UPDATE") || userCan(user, "FINANCES", "VALIDATE")}
          canViserBC={siegeAuCentreAdPro(user)}
          contexte={contexte}
          resume={false}
        />
      </CarteDetailsDemande>

      {/* LES PIÈCES LEGAL RATTACHÉES À LA DEMANDE ELLE-MÊME, hors postes — d'avant les postes, ou qui ne sont pas des achats. */}
      <PiecesLegalDeLaDemande spectateur={user} entityType="AD_PRO_OTHER" entityId={req.id} />

      {/* LES MÉDECINS CONCERNÉS (Direction, 08/10) — choisis dans l'annuaire : le lien que lisent le cockpit marketing et la fiche du praticien. */}
      <MedecinsConcernes user={user} entityType="AD_PRO_OTHER" entityId={req.id} />
      {/* LA SECTION DISCUSSION — le fil CANONIQUE, monté sur les sept natures du pôle. */}
      <AdProDiscussionCard entityType="AD_PRO_OTHER" entityId={req.id} user={user} />
    </div>
  );
}
