import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { toNumber, formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { PageHeader } from "@/components/shared/page-header";
import { VisaCentreBanniere } from "@/modules/ad-pro/ecrans/visa-centre-banniere";
import { SupprimerDemandeAdPro } from "@/modules/ad-pro/ecrans/supprimer-demande";
import { SupprimerDefinitivementDemandeAdPro } from "@/modules/ad-pro/ecrans/supprimer-definitivement";
import { peutSupprimerUneDemandeAdPro, adProEditValues, loadAdProItems, adProBudgetOptions, contexteMaterielStock, contextePostes, requireModuleOuAgences } from "@/modules/ad-pro/api";
import { BackLink } from "@/components/shared/back-link";
import { StatusBadge } from "@/components/shared/status-badge";
import { AD_PRO_DOC_CATEGORIES, categoriesDuDepotDeLaDemande, canAttachToAdPro, attachHint, canEditAdProRequest, isAdProDecided, barreDesEtapes, refusSuppressionDefinitive } from "@/modules/ad-pro/partage";
import type { DocItem } from "@/components/documents/document-list";
import { AD_PRO_OTHER_STATUS, ROLE_LABELS } from "@/lib/labels";
import { OtherDecisionPanel } from "./decision-panel";
import { AdProDiscussionCard } from "@/modules/ad-pro/ecrans/discussion-card";
import { MedecinsConcernesSection } from "@/modules/ad-pro/ecrans/medecins-concernes";
import { SectionRepliable } from "@/components/shared/section-repliable";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { AdProEditButton } from "@/modules/ad-pro/ecrans/edit-request-button";
import { WorkflowPanel, HistoriqueDuCircuit } from "@/components/workflow/workflow-panel";
import { circuitPourLaBarre } from "@/lib/workflow/frise-circuit";
import { resumeDuCircuit } from "@/lib/workflow/resume-circuit";
import { getWorkflowForEntity } from "@/lib/queries/workflow";
import { AdProItemsPanel } from "@/modules/ad-pro/ecrans/items-panel";
import { PiecesLegalDeLaDemande } from "@/modules/ad-pro/ecrans/pieces-legal-demande";
import { Faits, Fait, SectionTracabilite } from "@/modules/ad-pro/ecrans/carte-demande";
import { BarreEtapes, CarteAVous, CarteLaDemande, CartePostes, PlusDInformations, SectionPieces, ligneDeLaDemande, type GesteAVous } from "@/modules/ad-pro/ecrans/fiche";
import { droitsDesPostes, gesteDuCircuit, gestesDesPostes } from "@/modules/ad-pro/ecrans/fiche-gestes";
import { promoMaterialOptions } from "@/modules/ad-pro/actions-postes";

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
  const user = await requireModuleOuAgences("AD_PRO_OTHER");
  // LA PORTE DE LA FICHE (audit 27/10, SA-14) : société, parties prenantes, portée « ses demandes » — la même que
  // ses pièces. La liste était filtrée par entité ; la fiche s'ouvrait par son seul identifiant.
  if (!(await canAccessEntity(user, "AD_PRO_OTHER", params.id, "VIEW"))) notFound();
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
    select: { id: true, name: true, role: true },
  });
  const names = new Map(people.map((p) => [p.id, p.name]));
  const roleDemandeur = people.find((p) => p.id === req.requesterId)?.role ?? null;

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

  // ── LA FICHE SIMPLIFIÉE (maquette « Fiche Ad & Pro » validée, 24/11/2026) : la barre d'étapes, la carte « À vous », la
  // demande, le tableau des postes, puis « Plus d'informations ». Mêmes données, mêmes composants, mêmes gestes. ──
  const droitsPostes = droitsDesPostes(user, {
    canEdit: userCan(user, "AD_PRO_OTHER", "CREATE") || userCan(user, "AD_PRO_OTHER", "UPDATE") || canAllocateItems,
    canAllocate: canAllocateItems, fige: statut === "DONE", decided: prevalidee, contexte,
  });
  const postes = gestesDesPostes(items, droitsPostes);
  const barre = barreDesEtapes({
    nature: "AD_PRO_OTHER",
    circuit: circuitPourLaBarre(workflow),
    deposee: { detail: formatDate(req.createdAt, { day: "numeric", month: "short" }) },
    postes: { ouverts: prevalidee && statut !== "DONE", termines: statut === "DONE", aVous: postes.posteAVous, n: items.length },
    validationFinale: null,
    declaration: null,
  });
  const aVous = [
    gesteDuCircuit("AD_PRO_OTHER", req.id, workflow),
    ...postes.gestes,
  ].filter((g): g is GesteAVous => g !== null);
  const peutSupprimer = await peutSupprimerUneDemandeAdPro(user, "AD_PRO_OTHER", req.id);
  const montant = req.amount != null ? formatCurrency(toNumber(req.amount)) : null;

  return (
    <div className="space-y-5">
      <BackLink href="/ad-pro/autres"><ArrowLeft className="h-4 w-4" /> Autres demandes</BackLink>
      <PageHeader
        title={req.title}
        description={ligneDeLaDemande({
          reference: req.reference, par: req.requesterId ? names.get(req.requesterId) ?? null : null,
          role: roleDemandeur ? ROLE_LABELS[roleDemandeur] ?? null : null, le: req.createdAt,
        })}
      >
        <StatusBadge map={AD_PRO_OTHER_STATUS} value={statut} />
        {/* « ⋯ » : corriger, supprimer — les mêmes boutons, les mêmes droits, rangés (une nature qui n'avait AUCUNE
            suppression l'a reçue au §118.162). */}
        <MenuDossier>
          {editValues && <AdProEditButton kind="AD_PRO_OTHER" id={req.id} decided={demandeDecidee} values={editValues} />}
          <SupprimerDemandeAdPro kind="AD_PRO_OTHER" id={req.id} name={`${req.reference} — ${req.title}`} enabled={peutSupprimer} />
          <SupprimerDefinitivementDemandeAdPro kind="AD_PRO_OTHER" id={req.id} enabled={!refusSuppressionDefinitive(user)} />
        </MenuDossier>
      </PageHeader>

      {/* L'ÉTAT DU CENTRE AD & PRO (audit 360°, R07/R10) — pour une demande née avant le 27/10/2026, dont la
          porte du centre a pu rester posée. Les demandes nouvelles n'en ont plus : le DG valide le total des postes. */}
      <VisaCentreBanniere entityType="AD_PRO_OTHER" entityId={req.id} viewer={user} />

      <BarreEtapes etapes={barre} />
      <CarteAVous gestes={aVous} />

      <CarteLaDemande
        faits={[
          { label: "Pour qui / avec qui", valeur: req.beneficiary },
          { label: "Montant demandé", valeur: montant },
          { label: "Date", valeur: formatDate(req.createdAt) },
          { label: "Produits", valeur: req.product },
        ]}
        description={req.description}
      />

      {/* LES POSTES (27/10/2026) — ajoutés APRÈS la prévalidation par les parties prenantes, acceptés par la
          Direction Marketing (montant et budget) ; le DG valide leur TOTAL au-dessus du seuil (carte en tête). */}
      <CartePostes>
        <div className="space-y-3">
          {/* Avant la prévalidation, la phrase du panneau (`ajoutFerme`) le dit à qui ajoute ; celle-ci, aux autres. */}
          {!prevalidee && open && !(droitsPostes.canEdit && contexte.ajoutFerme) && (
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
            canEdit={droitsPostes.canEdit}
            canAllocate={canAllocateItems}
            promoOptions={promoOptions}
            budgetOptions={budgetOptions}
            materiel={materielStock}
            canIssueOrder={droitsPostes.canIssueOrder}
            canViserBC={droitsPostes.canViserBC}
            contexte={contexte}
            resume={false}
            tableau
          />
        </div>
      </CartePostes>

      {/* PLUS D'INFORMATIONS, REPLIÉ : tout le reste de la fiche, chaque partie avec son composant d'avant. */}
      <PlusDInformations resume={montant ? `demandé ${montant}` : null}>
        <SectionRepliable titre="Détails de la demande" resume={[req.company?.name, ligne.decidedAt ? `décidée le ${formatDate(ligne.decidedAt.toISOString())}` : null].filter(Boolean).join(" · ")}>
          <Faits>
            <Fait label="Entité" valeur={req.company?.name} />
            <Fait label="Demandeur" valeur={req.requesterId ? names.get(req.requesterId) : null} />
            {ligne.decidedById && <Fait label="Décidée par" valeur={names.get(ligne.decidedById)} />}
            {ligne.decidedAt && <Fait label="Décidée le" valeur={formatDate(ligne.decidedAt.toISOString())} />}
            {req.doctor && <Fait label="Médecins" valeur={req.doctor} />}
            {ligne.decisionNote && <Fait large label="Motif de la décision" valeur={ligne.decisionNote} />}
          </Faits>
        </SectionRepliable>
        {/* LES MÉDECINS CONCERNÉS (Direction, 08/10) — choisis dans l'annuaire : le lien que lisent le cockpit marketing et la
            fiche du praticien. */}
        <MedecinsConcernesSection user={user} entityType="AD_PRO_OTHER" entityId={req.id} />
        <SectionPieces
          pieces={{
            entityType: "AD_PRO_OTHER", entityId: req.id, documents: docItems,
            peutDeposer: canUploadDocs, motif: uploadHint,
            categories: categoriesDuDepotDeLaDemande(AD_PRO_DOC_CATEGORIES),
            canDelete: userCan(user, "AD_PRO_OTHER", "DELETE") || hasGlobalView(user.role),
            canRename: canUploadDocs, canEdit: onlyofficeConfigured() && canUploadDocs,
            path: `/ad-pro/autres/${req.id}`,
          }}
        >
          {/* LES PIÈCES LEGAL RATTACHÉES À LA DEMANDE ELLE-MÊME, hors postes — d'avant les postes, ou qui ne sont pas des achats. */}
          <PiecesLegalDeLaDemande spectateur={user} entityType="AD_PRO_OTHER" entityId={req.id} />
        </SectionPieces>
        {/* LA SECTION DISCUSSION — le fil CANONIQUE, monté sur les sept natures du pôle. */}
        <SectionRepliable titre="Discussion" sansCadre>
          <AdProDiscussionCard entityType="AD_PRO_OTHER" entityId={req.id} user={user} />
        </SectionRepliable>
        {/* LE CIRCUIT DÉTAILLÉ : prévalidation, avis, renvoi, resoumission, appel — la frise et la phrase de statut, sans les
            gestes de l'étape (ils sont dans « À vous ») ; la suite (« Terminée », l'annulation) reste ici. */}
        <SectionRepliable titre="Circuit de validation détaillé" resume={resumeDuCircuit(workflow)}>
          <div className="space-y-4">
            {workflow && <WorkflowPanel entityType="AD_PRO_OTHER" entityId={req.id} view={workflow} compact partie="frise" />}
            <OtherDecisionPanel
              id={req.id}
              status={statut}
              canClose={(mine || mayDecide) && (statut === "APPROVED" || statut === "REFUSED")}
            />
          </div>
        </SectionRepliable>
        <SectionTracabilite
          creeeLe={formatDateTime(req.createdAt)}
          modifieeLe={formatDateTime(req.updatedAt)}
          historique={user.role === "SUPER_ADMIN" && workflow && workflow.events.length > 0 ? <HistoriqueDuCircuit events={workflow.events} /> : null}
        />
      </PlusDInformations>
    </div>
  );
}
