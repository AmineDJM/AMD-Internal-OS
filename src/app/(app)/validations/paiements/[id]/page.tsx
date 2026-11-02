import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, peutVoirAdam } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber, formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PAYMENT_REQUEST_STATUS, PAYMENT_URGENCY, ENTITY_TYPE_LABELS } from "@/lib/labels";
import {
  canApprove, canResubmit, isOverdue, deadlineLabel, isWithFinance, piecesEnVigueur, isCompanionDossier,
  CENTRAL_STATUS_LABEL, CENTRAL_DECISION_LABEL, sitsOnPaymentCentre, type CentralStatus, type CentralDecision,
  deadlineNatureLabel, deadlineNatureOf, refusDeCorrection, refusDeRetrait, refusDeSuppression,
} from "@/modules/finances/partage";
import { entityHref } from "@/lib/entity-href";
import { existingEntityIds } from "@/lib/entity-exists";
import { PaymentDossier, type PieceView, type EventView } from "./dossier";
import { getMyCompanies } from "@/lib/company";
import { AskChief } from "@/components/shared/ask-chief";
import { realtimeVoiceConfigured, canUseRealtimeVoice } from "@/lib/assistant/voice-realtime";

export const dynamic = "force-dynamic";

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value) return null;
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><div className="font-medium [overflow-wrap:anywhere]">{value}</div></div>;
}

/**
 * LE DOSSIER D'UNE DEMANDE DE PAIEMENT.
 *
 * Gardé par le CERCLE du dossier — le demandeur, le destinataire désigné, les Finances — et non
 * par un module : celui qui fait payer une facture n'a aucune raison d'accéder au grand livre,
 * et ne doit pourtant jamais perdre de vue SA demande.
 */
export default async function PaymentRequestPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireUser();
  const req = await prisma.paymentRequest.findUnique({
    where: { id: params.id },
    include: {
      company: { select: { name: true } },
      pieces: { orderBy: { position: "asc" }, include: { replacedBy: { select: { id: true } } } },
      events: { orderBy: { at: "asc" } },
    },
  });
  if (!req) notFound();

  // LE LIEN « SE RATTACHE À » N'EST PROPOSÉ QUE SI L'OBJET EXISTE ENCORE. Un dossier compagnon
  // survit à un congrès effacé ; `entityHref` en ferait un lien vers une page 404 (mesuré par
  // l'audit navigateur). Un `link` explicite est gardé tel quel : il a été posé par un circuit
  // qui sait où il mène.
  const rattachementHref = req.link
    ? req.link
    : req.entityType && req.entityId && (await existingEntityIds(req.entityType, [req.entityId])).has(req.entityId)
      ? entityHref(req.entityType, req.entityId)
      : null;

  const isFinance = user.role === "FINANCE_BUDGET_MANAGER"
    || userCan(user, "FINANCES", "VALIDATE") || userCan(user, "FINANCES", "UPDATE") || hasGlobalView(user.role);
  const isRequester = req.requesterId === user.id || hasGlobalView(user.role);
  // Un dossier de paiement porte des montants et des factures : il n'est pas public. Seuls le
  // demandeur, les Finances et le destinataire désigné y entrent.
  if (!isFinance && !isRequester && req.recipientId !== user.id) redirect("/validations/paiements");

  const [docs, people, validations] = await Promise.all([
    prisma.document.findMany({
      where: { id: { in: req.pieces.map((p) => p.documentId) } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    // LES VALIDATIONS DÉJÀ DEMANDÉES, PIÈCE PAR PIÈCE. Sans elles, on redemande à valider ce
    // qui est déjà chez le Directeur Général : deux demandes arrivent sur le même écran et il
    // doit deviner laquelle fait foi.
    prisma.validationRequest.findMany({
      where: { entityType: "PAYMENT_REQUEST", entityId: req.id, documentId: { not: null } },
      select: { id: true, reference: true, status: true, documentId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const docName = new Map(docs.map((d) => [d.id, d.name]));
  const names = new Map(people.map((p) => [p.id, p.name]));

  // La validation la PLUS RÉCENTE par pièce : c'est elle qui décrit l'état actuel. Les
  // précédentes appartiennent à l'historique, que le fil du dossier porte déjà.
  const validationByDoc = new Map<string, (typeof validations)[number]>();
  for (const v of validations) if (v.documentId && !validationByDoc.has(v.documentId)) validationByDoc.set(v.documentId, v);

  const pieces: PieceView[] = req.pieces.map((p) => {
    const v = validationByDoc.get(p.documentId) ?? null;
    return {
      id: p.id, documentId: p.documentId, name: docName.get(p.documentId) ?? "Pièce",
      kind: p.kind, note: p.note, status: p.status, reviewNote: p.reviewNote,
      reviewedBy: p.reviewedById ? names.get(p.reviewedById) ?? null : null,
      replacedById: p.replacedBy?.id ?? null,
      addedBy: p.createdById ? names.get(p.createdById) ?? null : null,
      createdAt: formatDate(p.createdAt.toISOString()),
      validation: v ? { id: v.id, reference: v.reference, status: v.status } : null,
    };
  });
  const events: EventView[] = req.events.map((e) => ({
    id: e.id, kind: e.kind, message: e.message,
    actor: e.actorId ? names.get(e.actorId) ?? null : null,
    at: formatDateTime(e.at.toISOString()),
  }));

  // L'ORDRE DE DÉPENSE derrière ce dossier — sa référence se lit en tête d'un compagnon, pour
  // dire d'où il vient et où le paiement se décide.
  const companion = isCompanionDossier(req.origin);
  // ET OÙ EN EST SON AUTORISATION (audit 360°, R20) : la fiche ne montrait que la référence de
  // l'ordre — le demandeur devait aller au centre de paiement pour apprendre qu'il était refusé, et
  // pourquoi. L'état, qui a tranché, quand, et le motif de la dernière décision se lisent ici.
  const order = req.expenseOrderId
    ? await prisma.expenseOrder.findUnique({
        where: { id: req.expenseOrderId },
        select: {
          reference: true, status: true, centralStatus: true, centralDecidedAt: true, centralDecidedById: true,
          transactionId: true, paidDate: true,
          centralMessages: {
            where: { decision: { not: null } }, orderBy: { createdAt: "desc" }, take: 1,
            select: { decision: true, body: true, author: { select: { name: true } } },
          },
        },
      })
    : null;
  const derniereDecision = order?.centralMessages[0] ?? null;
  const decideur = order?.centralDecidedById
    ? (await prisma.user.findUnique({ where: { id: order.centralDecidedById }, select: { name: true } }))?.name ?? null
    : null;
  const etatCentre = order && order.centralStatus !== "NOT_REQUIRED" ? order.centralStatus as CentralStatus : null;
  // Le motif ne se répète pas quand il n'est que le libellé par défaut d'une autorisation sèche.
  const motifCentre = derniereDecision && derniereDecision.body !== CENTRAL_DECISION_LABEL[derniereDecision.decision as CentralDecision]
    ? derniereDecision.body : null;
  // Le centre ne montre une ligne qu'à ses sièges et à son demandeur : le lien n'est offert qu'à eux,
  // sinon il mènerait les Finances à une page qui leur explique qu'elles n'y siègent pas.
  const voitLeCentre = sitsOnPaymentCentre(user) || req.requesterId === user.id;

  const amount = toNumber(req.amount);
  // `entityType` et l'attestation entrent dans le calcul : c'est le rattachement qui exempte un
  // BON DE VERSEMENT du bon de commande et de la facture.
  // Les pièces EN VIGUEUR — la même lecture que les actions (§118.191) : une pièce remplacée ne compte
  // ni pour le bon à payer ni pour la transmission.
  const enVigueur = piecesEnVigueur(req.pieces);
  const approve = canApprove(
    { status: req.status, amount, entityType: req.entityType, paymentMethodStated: req.paymentMethodStated },
    enVigueur,
  );
  const resubmit = canResubmit(req, enVigueur);

  // CORRIGER LA DEMANDE (§118.191, audit R04) — la même règle que l'action, et ce que la demande porte.
  // L'entité ne se propose qu'au brouillon : après transmission, c'est la société qui paie.
  const refusCorrection = refusDeCorrection({
    status: req.status, compagnon: companion,
    ordre: order ? { status: order.status, centralStatus: order.centralStatus } : null,
  });
  const entitesCorrigeables = req.status === "DRAFT" && refusCorrection === null && isRequester
    ? (await getMyCompanies(user.id)).map((c) => ({ id: c.id, name: c.shortName || c.name }))
    : null;

  return (
    <div className="space-y-5">
      <BackLink href="/validations/paiements"><ArrowLeft className="h-4 w-4" /> Demandes de paiement</BackLink>
      <PageHeader title={req.title} description={`Réf. ${req.reference} · ${req.payee}`}>
        <StatusBadge map={PAYMENT_REQUEST_STATUS} value={req.status} />
        {isOverdue(req) && <Badge tone="danger" dot={false}>en retard</Badge>}
        {peutVoirAdam(user) && userCan(user, "CHIEF_OF_STAFF", "VIEW") && (
          <AskChief reference={req.reference} call={realtimeVoiceConfigured() && canUseRealtimeVoice(user)} />
        )}
      </PageHeader>

      <Card>
        <CardHeader><CardTitle>Le paiement demandé</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4 sm:gap-x-6">
          <Info label="Montant" value={<span className="text-base tabular-nums sm:text-sm">{formatCurrency(amount)}</span>} />
          <Info label="Bénéficiaire" value={req.payee} />
          <Info
            label="Échéance"
            value={
              <>
                {deadlineLabel(req, PAYMENT_URGENCY)}
                {/* LA DATE SEULE NE DIT QU'À MOITIÉ : « le 15 » n'est pas la même chose selon
                    qu'il s'agit d'un engagement pris ou d'un repère. */}
                {req.dueDate && (
                  <span className={deadlineNatureOf(req.deadlineNature) === "FIXED" ? "block text-xs font-semibold text-destructive" : "block text-xs text-muted-foreground"}>
                    {deadlineNatureLabel(req.deadlineNature)}
                  </span>
                )}
              </>
            }
          />
          <Info label="Demandeur" value={names.get(req.requesterId) ?? "—"} />
          {/* Le destinataire n'existe plus à la création — la demande va au CENTRE. La ligne
              survit pour les demandes anciennes, qui en portent un : la masquer effacerait leur
              historique. `Info` ne rend rien quand la valeur est absente. */}
          <Info label="Destinataire (Finances)" value={req.recipientId ? names.get(req.recipientId) : null} />
          <Info label="Entité" value={req.company?.name} />
          {/* LE CONTACT — celui qu'on appelle quand une pièce manque ou qu'un virement n'arrive
              pas. Sans lui, on cherche dans les mails de quelqu'un qui est en congé. */}
          <Info
            label="Contact bénéficiaire"
            value={[req.contactName, req.contactPhone, req.contactEmail].filter(Boolean).join(" · ") || null}
          />
          <Info
            label="Moyen de paiement"
            value={req.paymentMethodStated
              ? <span className="text-success">Mentionné dans le document</span>
              : <span className="text-warning">Non déclaré</span>}
          />
          <Info label="Décidé par" value={req.decidedById ? names.get(req.decidedById) : null} />
          <Info label="Décidé le" value={req.decidedAt ? formatDate(req.decidedAt.toISOString()) : null} />
          {/* CE QUI A FAIT NAÎTRE CE PAIEMENT, ouvrable d'un clic. Un dossier compagnon ne porte
              pas de `link` : sa route se DÉDUIT du rattachement (`entityHref`), qui tient la
              table des routes en un seul endroit. La recopier ici l'aurait fait diverger. */}
          {rattachementHref ? (
            <Info
              label="Se rattache à"
              value={<Link href={rattachementHref} className="inline-flex items-center gap-1 text-primary hover:underline">
                {req.entityType ? ENTITY_TYPE_LABELS[req.entityType] ?? req.entityType : "l'objet d'origine"} <ExternalLink className="h-3 w-3" />
              </Link>}
            />
          ) : req.entityType && req.entityId ? (
            // L'objet d'origine a disparu : on le DIT, au lieu d'un lien qui répond 404.
            <Info label="Se rattache à" value={`${ENTITY_TYPE_LABELS[req.entityType] ?? req.entityType} — source supprimée`} />
          ) : null}
          {/* L'ORDRE DE DÉPENSE — le vrai objet du décaissement. On le NOMME : sans lui, un
              dossier compagnon parle d'un paiement dont on ne retrouve pas la trace. */}
          <Info label="Ordre de dépense" value={order?.reference} />
          {etatCentre && (
            <Info
              label="Centre de paiement"
              value={
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Badge tone={etatCentre === "APPROVED" ? "success" : etatCentre === "REFUSED" ? "danger" : "warning"} dot={false}>
                    {CENTRAL_STATUS_LABEL[etatCentre]}
                  </Badge>
                  {order?.centralDecidedAt && etatCentre !== "AWAITING" && (
                    <span className="text-xs text-muted-foreground">
                      le {formatDate(order.centralDecidedAt.toISOString())}{decideur ? ` par ${decideur}` : ""}
                    </span>
                  )}
                  {voitLeCentre && (
                    <Link href="/centre-de-paiement" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      Voir au centre <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                </span>
              }
            />
          )}
          {etatCentre && etatCentre !== "AWAITING" && motifCentre && (
            <div className={`col-span-full rounded-lg px-3 py-2 ${etatCentre === "REFUSED" ? "bg-destructive/10" : "bg-secondary/40"}`}>
              <p className="text-xs text-muted-foreground">
                {etatCentre === "REFUSED" ? "Motif du refus du centre de paiement" : "Message du centre de paiement"}
                {derniereDecision?.author?.name ? ` — ${derniereDecision.author.name}` : ""}
              </p>
              <p className="whitespace-pre-wrap">{motifCentre}</p>
            </div>
          )}
          {req.description && (
            <div className="col-span-full"><p className="text-xs text-muted-foreground">Contexte</p><p className="whitespace-pre-wrap">{req.description}</p></div>
          )}
          {req.holdReason && (
            <div className="col-span-full rounded-lg bg-warning/10 px-3 py-2">
              <p className="text-xs text-muted-foreground">Motif de la mise en attente</p>
              <p className="whitespace-pre-wrap">{req.holdReason}</p>
            </div>
          )}
          {req.decisionNote && (
            <div className="col-span-full"><p className="text-xs text-muted-foreground">Note de décision</p><p className="whitespace-pre-wrap">{req.decisionNote}</p></div>
          )}
        </CardContent>
      </Card>

      <PaymentDossier
        id={req.id}
        reference={req.reference}
        status={req.status}
        isRequester={isRequester}
        isFinance={isFinance}
        pieces={pieces}
        events={events}
        people={people.filter((p) => p.id !== user.id)}
        canApproveNow={approve.ok}
        approveBlocker={approve.ok ? null : approve.reason ?? null}
        resubmitBlocker={resubmit.ok ? null : resubmit.reason ?? null}
        entityType={req.entityType}
        paymentMethodStated={req.paymentMethodStated}
        contact={{ name: req.contactName, phone: req.contactPhone, email: req.contactEmail }}
        isCompanion={companion}
        orderReference={order?.reference ?? null}
        withFinance={isWithFinance(req.status)}
        refusRetrait={refusDeRetrait({ status: req.status, compagnon: companion, ordre: order ? { status: order.status } : null })}
        supprimable={(req.requesterId === user.id || user.role === "SUPER_ADMIN")
          && refusDeSuppression({ status: req.status, compagnon: companion, ordre: order }) === null}
        correction={{
          refus: refusCorrection,
          valeurs: {
            title: req.title, payee: req.payee, amount, description: req.description,
            dueDate: req.dueDate ? req.dueDate.toISOString().slice(0, 10) : null,
            deadlineNature: deadlineNatureOf(req.deadlineNature), urgency: req.urgency, companyId: req.companyId,
          },
          entites: entitesCorrigeables,
          centreAutorise: order?.centralStatus === "APPROVED",
        }}
      />
    </div>
  );
}
