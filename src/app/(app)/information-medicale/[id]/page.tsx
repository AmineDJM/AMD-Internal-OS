import { BlocHistorique } from "@/components/ad-pro/bloc-historique";
import { refusAnnulationPieceInfoMed } from "@/lib/annulations/regles";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronRight, ExternalLink, FileText, CheckCircle2, Clock } from "lucide-react";
import { requireUser } from "@/lib/session";
import { hasGlobalView, userCan, scopeCongressIntl, scopeCongressNational, scopeSponsoring } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getDeclaration, canViewDeclaration, sourceLink, dernieresRelancesPieces, dernierRefusFinal } from "@/lib/queries/medical-info";
import { decideursInfoMedActifs } from "@/lib/medical-info";
import { estDecideurInfoMed, chezDecideur } from "@/lib/medical-info/decideur";
import { peutOuvrirLeDossierPromo } from "@/lib/queries/promo-circuit";
import { canAccessEntity } from "@/lib/entity-access";
import { toNumber, formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { DocumentUpload } from "@/components/documents/document-upload";
import { CommentThread } from "@/components/shared/comment-thread";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { addMedicalInfoComment } from "@/lib/actions/medical-info-actions";
import { updateComment, deleteComment } from "@/lib/actions/comment-actions";
import { onlyofficeConfigured } from "@/lib/onlyoffice";
import { DOC_REQUEST_STATUS, ENTITY_TYPE_LABELS } from "@/lib/labels";
import {
  CancelRequestButton, FulfillForm, AuthorityForm, ValidateButton, DirectionValidateButton, DeclareDecisionCard, SlipsCard,
  AuthorityLocked, DemanderPieceBouton, RelancerPieceButton, ProduitDeclarationForm,
} from "./panels";
import { Frise } from "./frise";
import { CIRCUIT_LABEL, DECLARATION_KIND_LABEL, isDeclarationKind, ordreGlobalALaValidation } from "@/lib/medical-info/circuits";
import { canRequestDecision, declareMessage } from "@/lib/medical-info/declare-decision";
import { canEditSlips, canRequestSlipsValidation, slipStage, slipsMessage, slipSansPaiementVivant } from "@/lib/medical-info/slips";
import { circuitStateOf, authoritiesOpen } from "@/lib/medical-info/circuit-state";
import {
  parcoursOf, libellePastille, carteAction, pharmacienPeutValider, peutRelancerPiece, joursDepuis, type BlocAction,
} from "@/lib/medical-info/parcours";
import { produitsDesDossiers } from "@/lib/medical-info/produits";
import { BackLink } from "@/components/shared/back-link";

export const dynamic = "force-dynamic";

export default async function DeclarationDetailPage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  const decl = await getDeclaration(params.id);
  if (!decl) notFound();
  if (!canViewDeclaration(user, decl)) notFound();

  const canManage = hasGlobalView(user.role) || userCan(user, "MEDICAL_INFO", "VALIDATE");

  // ── DEUX CIRCUITS, ET LA NATURE DÉCIDE ───────────────────────────────────────────────────
  //
  // Le bon de versement ne concerne QUE le matériel promotionnel. Une prise en charge, un
  // sponsoring, un événement n'appellent aucun versement : ils appellent une DÉCISION — faut-il
  // les déclarer au ministère de l'Industrie pharmaceutique ? L'état ne vit dans aucun champ : il
  // se compose des validations, des demandes de paiement, de leur passage au centre, de leur
  // règlement et de la remise de chaque quittance au bureau du PRIM.
  const etat = await circuitStateOf(decl);
  const autoritesOuvertes = authoritiesOpen(etat);
  const canDeliverSlips = userCan(user, "FINANCES", "UPDATE") || hasGlobalView(user.role);
  // La carte des bons, montrée aux Finances hors du bloc du pharmacien (audit 360°, I9).
  const carteFinances = !canManage && canDeliverSlips && etat.circuit === "PROMO" && etat.slips.some((sl) => sl.requestId);
  const lotEditable = canEditSlips(etat.lot);
  const isValidated = decl.status === "VALIDATED";
  // QUI TRANCHE (Direction, 10/2026) : le Directeur des Opérations, à défaut le Super Admin — jamais le
  // pharmacien qui a lui-même validé le dossier (la même porte que `validateDeclarationByDirection`).
  const isDirection = estDecideurInfoMed(user) && (user.role === "SUPER_ADMIN" || decl.pharmacistValidatedById !== user.id);
  // Instruire, c'est avant la validation finale : après, les gestes du pharmacien se referment.
  const instruit = canManage && !isValidated;
  // UN PAIEMENT DE MATÉRIEL PROMOTIONNEL (§118.152) : la source déclarée est la FACTURE (une pièce
  // Legal), mais ce que le pharmacien instruit — le support à faire viser — vit sur le DOSSIER de
  // matériel promotionnel dont elle découle. On remonte la chaîne une fois : le lien, les pièces et
  // le libellé désignent le dossier, sans quoi la fiche disait « Document juridique » et ne menait
  // nulle part.
  const promoSource = decl.sourceType === "LEGAL_DOCUMENT"
    ? await (async () => {
        const piece = await prisma.legalDocument.findUnique({ where: { id: decl.sourceId }, select: { sourceType: true, sourceId: true, reference: true } });
        if (piece?.sourceType !== "PROMO_MATERIAL" || !piece.sourceId) return null;
        const pm = await prisma.promoMaterial.findUnique({
          where: { id: piece.sourceId },
          select: { id: true, reference: true, requesterId: true, assistantId: true, requestValidatorId: true, marketingValidatorId: true, companyId: true },
        });
        return pm ? { pm, facture: piece.reference } : null;
      })()
    : null;
  const link = promoSource ? `/promo-material/${promoSource.pm.id}` : sourceLink(decl.sourceType, decl.sourceId);
  const sourceLabel = promoSource
    ? `Matériel promotionnel ${promoSource.pm.reference}${promoSource.facture ? ` — facture ${promoSource.facture}` : ""}`
    : (ENTITY_TYPE_LABELS[decl.sourceType] ?? decl.sourceType);
  // On ne montre le lien vers l'événement source que s'il est RÉELLEMENT ouvrable
  // par cet utilisateur (sinon la page source renvoyait un 404 — hors portée).
  let canOpenSource = false;
  if (promoSource) {
    canOpenSource = await peutOuvrirLeDossierPromo(user, promoSource.pm);
  } else if (link) {
    if (hasGlobalView(user.role)) canOpenSource = true;
    else if (decl.sourceType === "SPONSORING")
      canOpenSource = userCan(user, "SPONSORING", "VIEW") &&
        (await prisma.sponsoringRequest.count({ where: { AND: [{ id: decl.sourceId }, scopeSponsoring(user)] } })) > 0;
    else if (decl.sourceType === "CONGRESS_INTERNATIONAL")
      canOpenSource = userCan(user, "CONGRESS_INTERNATIONAL", "VIEW") &&
        (await prisma.congressInternational.count({ where: { id: decl.sourceId, ...scopeCongressIntl(user) } })) > 0;
    else if (decl.sourceType === "CONGRESS_NATIONAL")
      canOpenSource = userCan(user, "CONGRESS_NATIONAL", "VIEW") &&
        (await prisma.congressNational.count({ where: { id: decl.sourceId, ...scopeCongressNational(user) } })) > 0;
    else if (decl.sourceType === "EVENT") canOpenSource = userCan(user, "EVENTS", "VIEW");
    // La demande « autre » (27/10/2026) : la porte de SA fiche.
    else if (decl.sourceType === "AD_PRO_OTHER") canOpenSource = await canAccessEntity(user, "AD_PRO_OTHER", decl.sourceId, "VIEW");
  }
  const amount = decl.amount != null ? toNumber(decl.amount) : null;
  const pendingCount = decl.requests.filter((r) => r.status === "PENDING").length;

  const [documents, users, comments, sourceDocuments, requesterUser, relances, produits, nosProduits, decideurs, refusFinal] = await Promise.all([
    prisma.document.findMany({
      where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: decl.id },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    canManage
      ? prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } })
      : Promise.resolve([]),
    prisma.comment.findMany({
      where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: decl.id },
      include: { author: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    // Pièces déjà jointes à l'événement source (congrès / sponsoring), consultables ici. Pour un
    // paiement de matériel promotionnel : la facture ET les pièces du dossier (maquettes, BAT…).
    prisma.document.findMany({
      where: promoSource
        ? { OR: [{ entityType: decl.sourceType, entityId: decl.sourceId }, { entityType: "PROMO_MATERIAL", entityId: promoSource.pm.id }] }
        : { entityType: decl.sourceType, entityId: decl.sourceId },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    decl.requesterId ? prisma.user.findUnique({ where: { id: decl.requesterId }, select: { name: true } }) : Promise.resolve(null),
    pendingCount > 0 ? dernieresRelancesPieces(decl.id) : Promise.resolve(new Map<string, Date>()),
    produitsDesDossiers([decl]),
    // NOS PRODUITS, pour corriger celui de la déclaration — seulement pour qui peut le faire.
    canManage && decl.status !== "VALIDATED"
      ? prisma.product.findMany({ where: { isActive: true }, select: { id: true, canonicalName: true }, orderBy: { canonicalName: "asc" }, take: 1000 })
      : Promise.resolve([]),
    // CHEZ QUI ATTEND CE QUE LE PHARMACIEN A FAIT VALIDER — le Directeur des Opérations, ou le Super Admin à défaut.
    decideursInfoMedActifs(decl.pharmacistValidatedById ?? decl.pharmacistId),
    // LE DERNIER REFUS de la validation finale, tant que le dossier est revenu au pharmacien.
    !isValidated && decl.status !== "AWAITING_DIRECTION" ? dernierRefusFinal(decl.id) : Promise.resolve(null),
  ]);
  const produit = produits.get(decl.id) ?? null;

  const toDocItem = (d: (typeof documents)[number]): DocItem => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  });
  const sourceDocItems: DocItem[] = sourceDocuments.map(toDocItem);
  const docItems: DocItem[] = documents.map(toDocItem);
  const docById = new Map(documents.map((d) => [d.id, d.name]));
  const commentItems = comments.map((c) => ({
    id: c.id, author: c.author?.name ?? "Utilisateur", authorId: c.authorId, body: c.body,
    createdAt: c.createdAt.toISOString(), editedAt: c.editedAt?.toISOString() ?? null,
  }));

  // ── OÙ EN EST-IL, ET QUE RESTE-T-IL À FAIRE POUR CELUI QUI REGARDE ────────────────────────
  const parcours = parcoursOf({
    circuit: etat.circuit, status: decl.status, createdAt: decl.createdAt, updatedAt: decl.updatedAt,
    declare: etat.declare, declareRequestedAt: decl.declareRequestedAt, authorityRef: decl.authorityRef,
    lot: etat.lot, slips: etat.slips, summary: etat.summary, skipped: etat.skipped, bvRequestedAt: decl.bvRequestedAt,
    requests: decl.requests.map((r) => ({
      id: r.id, status: r.status, createdAt: r.createdAt, fulfilledAt: r.fulfilledAt,
      targetUserId: r.targetUserId, targetName: r.targetUser?.name ?? null,
    })),
    pharmacistValidatedAt: decl.pharmacistValidatedAt, validatedAt: decl.validatedAt, pharmacistName: decl.pharmacist?.name ?? null,
    chezDecideur: chezDecideur(decideurs),
  });
  const mesPieces = isValidated ? [] : decl.requests.filter((r) => r.status === "PENDING" && r.targetUserId === user.id);
  const carte = carteAction(parcours, {
    gestionnaire: instruit,
    direction: isDirection,
    finances: carteFinances,
    aDeposer: mesPieces.length,
    aRemettre: etat.slips.some((sl) => slipStage(sl) === "PAYE"),
  }, {
    pharmacienPeutValider: pharmacienPeutValider({ ...etat, authorityRef: decl.authorityRef, declarationKind: decl.declarationKind }),
    autoritesOuvertes,
  });
  const blocsCarte = new Set<BlocAction>([...carte.principal, ...(carte.aussi ? [carte.aussi.bloc] : [])]);
  const bonsDansLaCarte = blocsCarte.has("BONS") || blocsCarte.has("REMETTRE_QUITTANCE");
  // Les pièces que la carte montre déjà ne se répètent pas dans la section « Pièces ».
  const piecesDansLaCarte = new Set<string>([
    ...mesPieces.map((r) => r.id),
    ...(blocsCarte.has("PIECES_ATTENDUES") ? decl.requests.filter((r) => r.status === "PENDING").map((r) => r.id) : []),
  ]);

  // ── UNE DEMANDE DE PIÈCE, telle qu'elle se lit partout : à qui, depuis quand, les gestes permis.
  const ligneDemande = (r: (typeof decl.requests)[number]) => {
    const mine = r.targetUserId === user.id;
    const jours = joursDepuis(r.createdAt);
    const relancable = r.status === "PENDING" && !isValidated && !mine && r.targetUserId && (canManage || r.requestedById === user.id);
    const relance = relancable
      ? peutRelancerPiece(r, { userId: user.id, gestionnaire: canManage, derniereRelance: relances.get(r.id) ?? null })
      : null;
    return (
      <li key={r.id} className="py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{r.label}</p>
            <p className="text-xs text-muted-foreground">
              {mine ? "Demandée à vous" : `Demandée à ${r.targetUser?.name ?? "—"}`}
              {r.status === "PENDING" && jours != null && <> · il y a {jours} j</>}
              {r.fulfilledAt && <> · déposée le {formatDate(r.fulfilledAt.toISOString())}</>}
            </p>
            {r.note && <p className="mt-0.5 text-xs text-muted-foreground">Note : {r.note}</p>}
            {r.status === "FULFILLED" && r.documentId && docById.has(r.documentId) && (
              <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-success"><FileText className="h-3.5 w-3.5" /> {docById.get(r.documentId)}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {r.status !== "PENDING" && <StatusBadge map={DOC_REQUEST_STATUS} value={r.status} dot={false} />}
            {relance && <RelancerPieceButton id={r.id} refus={relance.ok ? null : relance.raison} />}
            {refusAnnulationPieceInfoMed(r, { userId: user.id, gestionnaire: canManage }) === null && <CancelRequestButton id={r.id} />}
          </div>
        </div>
        {r.status === "PENDING" && mine && <FulfillForm requestId={r.id} />}
        {/* Le pharmacien peut déposer à la place de la personne sollicitée — un geste replié. */}
        {r.status === "PENDING" && !mine && canManage && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Déposer à sa place</summary>
            <FulfillForm requestId={r.id} />
          </details>
        )}
      </li>
    );
  };

  // LES BONS DE VERSEMENT — UN tableau, rendu une seule fois : celui du pharmacien (ses gestes du
  // lot) ou celui des Finances (la seule remise). Les deux ne coexistent jamais à l'écran.
  const blocBons = etat.circuit !== "PROMO" ? null : (
    <>
      {canManage && (
        <SlipsCard
          id={decl.id}
          lot={etat.lot}
          slips={etat.slips.map((sl) => ({
            id: sl.id, label: sl.label, amount: sl.amount, note: sl.note,
            requestId: sl.requestId, centralStatus: sl.centralStatus, orderStatus: sl.orderStatus, requestStatus: sl.requestStatus ?? null,
            deliveredAt: sl.deliveredAt, deliveredAtIso: sl.deliveredAt?.toISOString() ?? null,
          }))}
          summary={etat.summary}
          canEdit={instruit && lotEditable}
          canValidate={instruit && canRequestSlipsValidation(etat.lot, etat.slips).ok}
          canManage={instruit}
          canDeliver={canDeliverSlips}
          canSkip={instruit && (lotEditable || etat.lot === "QUITTANCE_A_DEMANDER") && !etat.skipped && etat.slips.every(slipSansPaiementVivant)}
          skipReason={etat.skipped ? decl.bvSkipReason : null}
          validationHref={decl.bvValidationId ? `/validations/${decl.bvValidationId}` : null}
        />
      )}
      {/* LES FINANCES REMETTENT LES QUITTANCES (audit 360°, I9) : le tableau des bons leur est
          montré en lecture, avec le seul geste qui leur revient — « Quittance remise ». */}
      {carteFinances && (
        <SlipsCard
          id={decl.id}
          lot={etat.lot}
          slips={etat.slips.map((sl) => ({
            id: sl.id, label: sl.label, amount: sl.amount, note: sl.note,
            requestId: sl.requestId, centralStatus: sl.centralStatus, orderStatus: sl.orderStatus, requestStatus: sl.requestStatus ?? null,
            deliveredAt: sl.deliveredAt, deliveredAtIso: sl.deliveredAt?.toISOString() ?? null,
          }))}
          summary={etat.summary}
          canEdit={false}
          canValidate={false}
          canManage={false}
          canDeliver
          canSkip={false}
          skipReason={etat.skipped ? decl.bvSkipReason : null}
          validationHref={null}
        />
      )}
    </>
  );

  const depot = autoritesOuvertes ? (
    <div className="space-y-3">
      <AuthorityForm id={decl.id} authorityRef={decl.authorityRef} authorityNotes={decl.authorityNotes} />
      <div className="space-y-1.5 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">Joindre un récépissé (facultatif)</p>
        <DocumentUpload entityType="MEDICAL_INFO_DECLARATION" entityId={decl.id} categories={["SUPPORTING_DOC", "OTHER"]} compact />
      </div>
    </div>
  ) : (
    <AuthorityLocked message={etat.circuit === "EVENT"
      ? declareMessage(etat.declare, { authorityRef: decl.authorityRef })
      : slipsMessage(etat.lot, etat.summary)} />
  );

  const rendreBloc = (bloc: BlocAction): ReactNode => {
    switch (bloc) {
      case "PIECES_A_DEPOSER":
        return <ul className="divide-y divide-border">{mesPieces.map(ligneDemande)}</ul>;
      case "PIECES_ATTENDUES":
        return <ul className="divide-y divide-border">{decl.requests.filter((r) => r.status === "PENDING" && r.targetUserId !== user.id).map(ligneDemande)}</ul>;
      case "DECLARER":
        return (
          <DeclareDecisionCard
            id={decl.id}
            state={etat.declare}
            authorityRef={decl.authorityRef}
            canRequest={instruit && canRequestDecision(etat.declare)}
            validationHref={decl.declareValidationId ? `/validations/${decl.declareValidationId}` : null}
          />
        );
      case "BONS":
      case "REMETTRE_QUITTANCE":
        return blocBons;
      case "DEPOT":
        return depot;
      case "VALIDER_PHARMACIEN":
        return <ValidateButton id={decl.id} hasPending={pendingCount > 0} />;
      case "VALIDER_DIRECTION":
        return <DirectionValidateButton id={decl.id} amount={ordreGlobalALaValidation(decl) ? amount : null} />;
    }
  };
  // « BONS » et « REMETTRE_QUITTANCE » montrent le même tableau : une seule fois.
  const principal = carte.principal.filter((b, i, all) =>
    !(b === "REMETTRE_QUITTANCE" && all.includes("BONS")) && all.indexOf(b) === i);

  return (
    <div className="space-y-5">
      <BackLink href="/information-medicale">
        <ArrowLeft className="h-4 w-4" /> Information médicale
      </BackLink>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">
            <span className="font-mono text-base text-muted-foreground">{decl.reference}</span> · {decl.label}
          </h1>
          <p className="text-sm text-muted-foreground">
            {CIRCUIT_LABEL[etat.circuit]}
            {" · "}
            {isDeclarationKind(decl.declarationKind) ? DECLARATION_KIND_LABEL[decl.declarationKind] : sourceLabel}
            {amount != null && <> · {formatCurrency(amount)}</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={parcours.ton}>{libellePastille(parcours)}</Badge>
          {user.role === "SUPER_ADMIN" && (
            <MenuDossier>
              <SuperAdminDeleteButton kind="MEDICAL_INFO_DECLARATION" id={decl.id} name={decl.reference} enabled />
            </MenuDossier>
          )}
        </div>
      </div>

      <BlocHistorique user={user} type="MEDICAL_INFO_DECLARATION" id={decl.id} />

      <Card>
        <CardContent className="space-y-4 py-4">
          <Frise etapes={parcours.etapes} />

          <section className="space-y-3 border-t border-border pt-4" aria-labelledby="reste-a-faire">
            <h2 id="reste-a-faire" className="text-sm font-semibold">Ce qu&apos;il reste à faire</h2>
            {/* LE REFUS DE LA VALIDATION FINALE revient au pharmacien AVEC son motif : sans lui, il
                reprendrait le dossier sans savoir quoi corriger. */}
            {refusFinal && (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                Validation finale refusée{refusFinal.par ? ` par ${refusFinal.par}` : ""} le {formatDate(refusFinal.le.toISOString())} — {refusFinal.motif}
              </p>
            )}
            {principal.map((b) => <div key={b}>{rendreBloc(b)}</div>)}
            {carte.aussi && (
              <details className="rounded-lg border border-border px-3 py-2">
                <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">{carte.aussi.libelle}</summary>
                <div className="pt-3">{rendreBloc(carte.aussi.bloc)}</div>
              </details>
            )}
            {carte.attente && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4 shrink-0" aria-hidden /> {carte.attente}
              </p>
            )}
            {isValidated && (
              <p className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                Dossier validé{decl.validatedAt ? ` le ${formatDate(decl.validatedAt.toISOString())}` : ""}
                {decl.expenseOrderId ? " — ordre de dépense transmis au comptable" : ""}
              </p>
            )}
            {instruit && (
              <div className="flex flex-wrap gap-2 pt-1">
                <DemanderPieceBouton declarationId={decl.id} users={users} />
              </div>
            )}
          </section>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="divide-y divide-border py-1">
          <Repli titre={`L'événement${amount != null ? ` · ${formatCurrency(amount)}` : ""}`}>
            <div className="space-y-2 text-sm">
              <Row label="Type" value={sourceLabel} />
              <Row label="Demandeur (à la source)" value={requesterUser?.name ?? "—"} />
              <Row label="Budget accordé" value={amount != null ? formatCurrency(amount) : "—"} />
              <Row label="Bénéficiaire" value={decl.beneficiary ?? "—"} />
              <div className="flex items-start justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">Produit</span>
                <span className="min-w-0 break-words text-right font-medium">
                  {!produit ? "—" : produit.id
                    ? <Link href={`/produits/${produit.id}`} className="text-primary hover:underline">{produit.nom}</Link>
                    : produit.nom}
                  {produit && produit.autres > 0 && <span className="font-normal text-muted-foreground"> +{produit.autres}</span>}
                </span>
              </div>
              {/* Le produit est repris de la source à la création ; le pharmacien le corrige ici, parmi nos produits. */}
              {nosProduits.length > 0 && (
                <ProduitDeclarationForm id={decl.id} productId={decl.productId} produits={nosProduits.map((p) => ({ id: p.id, nom: p.canonicalName }))} />
              )}
              <Row label="Pharmacien responsable" value={decl.pharmacist?.name ?? "Non assigné"} />
              <Row label="Créé le" value={formatDate(decl.createdAt.toISOString())} />
              {decl.authorityRef && <Row label="Référence ministère" value={decl.authorityRef} />}
              {decl.authorityNotes && <Row label="Notes de déclaration" value={decl.authorityNotes} />}
              {decl.pharmacistValidatedAt && <Row label="Validé (pharmacien) le" value={formatDateTime(decl.pharmacistValidatedAt.toISOString())} />}
              {isValidated && decl.validatedAt && <Row label="Validé (validation finale) le" value={formatDateTime(decl.validatedAt.toISOString())} />}
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
                {link && canOpenSource && (
                  <Link href={link} className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
                    <ExternalLink className="h-3.5 w-3.5" /> {promoSource ? "Voir le dossier de matériel promotionnel" : "Voir l'événement source"}
                  </Link>
                )}
                {decl.declareValidationId && !blocsCarte.has("DECLARER") && (
                  <Link href={`/validations/${decl.declareValidationId}`} className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
                    <FileText className="h-3.5 w-3.5" /> Décision « à déclarer ? »
                  </Link>
                )}
              </div>
            </div>
          </Repli>

          <Repli titre={`Pièces · ${docItems.length + sourceDocItems.length}`}>
            <div className="space-y-4">
              {decl.requests.some((r) => !piecesDansLaCarte.has(r.id)) && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Demandées</p>
                  <ul className="divide-y divide-border">
                    {decl.requests.filter((r) => !piecesDansLaCarte.has(r.id)).map(ligneDemande)}
                  </ul>
                </div>
              )}
              {docItems.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Déposées au dossier</p>
                  <DocumentList documents={docItems} canDelete={canManage} canEdit={onlyofficeConfigured() && canManage} path={`/information-medicale/${decl.id}`} />
                </div>
              )}
              {sourceDocItems.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {promoSource ? "Du dossier (support, facture)" : "De l'événement"}
                  </p>
                  <DocumentList documents={sourceDocItems} canDelete={false} path={`/information-medicale/${decl.id}`} />
                </div>
              )}
              {decl.requests.length === 0 && docItems.length === 0 && sourceDocItems.length === 0 && (
                <p className="text-sm text-muted-foreground">Aucune pièce.</p>
              )}
            </div>
          </Repli>

          {blocBons && !bonsDansLaCarte && (canManage || carteFinances) && (
            <Repli titre={`Bons de versement · ${etat.summary.delivered}/${etat.summary.count} remis`}>{blocBons}</Repli>
          )}

          <Repli titre={`Discussion · ${commentItems.length}`}>
            <CommentThread
              comments={commentItems}
              action={addMedicalInfoComment}
              hiddenFields={{ declarationId: decl.id }}
              currentUserId={user.id}
              canModerate={canManage}
              updateAction={updateComment}
              deleteAction={deleteComment}
              path={`/information-medicale/${decl.id}`}
            />
          </Repli>
        </CardContent>
      </Card>
    </div>
  );
}

/** Une section repliée — ce qu'on lit à la demande. */
function Repli({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <details className="group py-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium hover:text-primary [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden /> {titre}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-medium">{value}</span>
    </div>
  );
}
