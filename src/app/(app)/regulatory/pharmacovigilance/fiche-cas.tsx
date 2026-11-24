import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, MessagesSquare, Paperclip, Search, ShieldAlert, Users } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { userCan, type SessionUser } from "@/lib/rbac";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/shared/status-badge";
import { BackLink } from "@/components/shared/back-link";
import { PageHeader } from "@/components/shared/page-header";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { DocumentUpload } from "@/components/documents/document-upload";
import { CommentThread, type CommentItem } from "@/components/shared/comment-thread";
import { updateComment, deleteComment } from "@/lib/actions/comment-actions";
import { commenterCasPv } from "@/lib/actions/pharmacovigilance-actions";
import { lecteurPv } from "@/lib/pharmacovigilance/acces";
import { GRAVITE_PV, SEXE_PV, STATUT_PV, lecteurDuCasPv, peutJoindreAuCasPv, statutsSuivantsPv, type StatutPv } from "@/lib/pharmacovigilance/regles";
import { formatDate, formatDateTime } from "@/lib/utils";
import { InstructionCasPv } from "./instruction";
import { ParticipantsCasPv } from "./participants-pv";

/**
 * LA FICHE D'UN CAS DE PHARMACOVIGILANCE (Direction, 06/10) — ce qui a été signalé, où en est l'instruction, et en bas
 * l'ÉCHANGE entre le KAM, Regulatory et les personnes ajoutées. Deux routes la montrent : Regulatory
 * (`/regulatory/pharmacovigilance/[id]`) et le KAM depuis Promotion médicale › Rapports (`/medical/rapports/pharmacovigilance/[id]`) —
 * une fiche, deux portes, la même règle (`lecteurDuCasPv`).
 */
export async function FicheCasPv({ user, id, retour, base }: {
  user: SessionUser;
  id: string;
  retour: { href: string; label: string };
  /** Le chemin de la fiche (pour revalider après modération d'un message). */
  base: string;
}) {
  const cas = await prisma.pharmacovigilanceCase.findUnique({
    where: { id },
    include: { participants: { select: { userId: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!cas) notFound();
  const l = lecteurPv(user);
  if (!lecteurDuCasPv(l, cas)) notFound();
  const chemin = `${base}/${cas.id}`;

  const [docs, fil, personnes] = await Promise.all([
    prisma.document.findMany({
      where: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.comment.findMany({
      where: { entityType: "PHARMACOVIGILANCE_CASE", entityId: cas.id },
      include: { author: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.user.findMany({
      where: { id: { in: [cas.reporterId, ...cas.participants.map((p) => p.userId), ...(cas.investigationOpenedById ? [cas.investigationOpenedById] : []), ...(cas.closedById ? [cas.closedById] : [])] } },
      select: { id: true, name: true },
    }),
  ]);
  const nom = (uid: string | null) => (uid ? personnes.find((p) => p.id === uid)?.name ?? "—" : "—");
  const docItems: DocItem[] = docs.map((d) => ({
    id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes,
    confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null,
    createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey),
  }));
  const commentaires: CommentItem[] = fil.map((c) => ({
    id: c.id, author: c.author?.name ?? "—", authorId: c.authorId ?? undefined, body: c.body,
    createdAt: c.createdAt.toISOString(), editedAt: c.editedAt?.toISOString() ?? null,
  }));
  const status = cas.status as StatutPv;
  const peutJoindre = peutJoindreAuCasPv(l, cas);
  const suiveurs = new Set([cas.reporterId, ...cas.participants.map((p) => p.userId)]);
  const candidats = l.instruit
    ? await prisma.user.findMany({ where: { isActive: true, id: { notIn: [...suiveurs] } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];
  const participants = cas.participants.map((p) => ({ userId: p.userId, nom: nom(p.userId) }));
  const estDeclarant = cas.reporterId === user.id;
  // LE PRODUIT MÈNE À SA FICHE PRODUITS 360 — son canonique, ou celui du produit de BU choisi au signalement.
  const produitId = cas.productId ?? (cas.promoProductId ? (await prisma.promoProduct.findUnique({ where: { id: cas.promoProductId }, select: { productId: true } }))?.productId ?? null : null);
  const lienProduit = produitId && userCan(user, "PRODUCTS", "VIEW") ? `/produits/${produitId}` : null;
  // LA VISITE D'OÙ PART LE CAS (Visite médicale 11/2026) : son compte rendu se lit ici — qui lit le cas lit ce que le
  // délégué a écrit ce jour-là, sans avoir à le chercher.
  const visite = cas.visitId
    ? await prisma.medicalVisit.findUnique({
        where: { id: cas.visitId },
        select: { date: true, report: true, doctor: { select: { name: true } }, delegate: { select: { name: true } } },
      })
    : null;

  return (
    <div className="space-y-5">
      <BackLink href={retour.href}>
        <ArrowLeft className="h-4 w-4" /> {retour.label}
      </BackLink>

      <PageHeader title={`${cas.reference} — ${cas.productLabel}`} description={`${cas.institutionName} · survenu le ${formatDate(cas.occurredOn)} · signalé par ${nom(cas.reporterId)}`}>
        <StatusBadge map={STATUT_PV} value={status} />
      </PageHeader>

      {/* L'ENQUÊTE OUVERTE se lit en premier : c'est ce qu'on attend du KAM. */}
      {status === "ENQUETE" && cas.requestedInfo && (
        <Card className="border-warning/40">
          <CardHeader><CardTitle className="flex items-center gap-2"><Search className="h-4 w-4" /> Enquête approfondie — informations demandées</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="whitespace-pre-wrap rounded-lg bg-secondary/40 px-3 py-2">{cas.requestedInfo}</p>
            <p className="text-xs text-muted-foreground">
              Ouverte par {nom(cas.investigationOpenedById)}{cas.investigationOpenedAt ? ` le ${formatDateTime(cas.investigationOpenedAt)}` : ""}.
              {estDeclarant && " Répondez dans l'échange ci-dessous et joignez les pièces utiles."}
            </p>
          </CardContent>
        </Card>
      )}
      {status === "CLOS" && (
        <Card className="border-success/40">
          <CardHeader><CardTitle>Cas clos</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {cas.closingNote && <p className="whitespace-pre-wrap">{cas.closingNote}</p>}
            <p className="text-xs text-muted-foreground">Par {nom(cas.closedById)}{cas.closedAt ? ` le ${formatDateTime(cas.closedAt)}` : ""}.</p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Le signalement</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <Info label="Produit">{lienProduit ? <Link href={lienProduit} className="text-primary hover:underline">{cas.productLabel}</Link> : cas.productLabel}</Info>
              <Info label="Établissement">{cas.institutionName}</Info>
              <Info label="Date de survenue">{formatDate(cas.occurredOn)}</Info>
              <Info label="Signalé le">{formatDateTime(cas.createdAt)}</Info>
              {cas.doctorName && <Info label="Médecin">{cas.doctorName}</Info>}
              {visite && (
                <Info label="Visite liée">
                  {formatDate(visite.date)}{visite.doctor?.name ? ` — ${visite.doctor.name}` : ""}{visite.delegate?.name ? ` (${visite.delegate.name})` : ""}
                </Info>
              )}
              <Info label="Gravité">
                {cas.severity ? <StatusBadge map={GRAVITE_PV} value={cas.severity} dot={false} /> : <span className="text-muted-foreground">Non précisée</span>}
              </Info>
              {(cas.patientAge !== null || cas.patientSex) && (
                <Info label="Patient">
                  {[cas.patientSex ? SEXE_PV[cas.patientSex] ?? cas.patientSex : null, cas.patientAge !== null ? `${cas.patientAge} ans` : null].filter(Boolean).join(", ")}
                </Info>
              )}
              <div className="min-w-0 sm:col-span-2">
                <p className="text-xs text-muted-foreground">Ce qui s&apos;est passé</p>
                <p className="mt-0.5 whitespace-pre-wrap">{cas.description}</p>
              </div>
              {visite?.report && (
                <details className="min-w-0 rounded-lg bg-secondary/40 px-3 py-2 sm:col-span-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">Compte rendu de la visite liée</summary>
                  <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{visite.report}</p>
                </details>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Paperclip className="h-4 w-4" /> Pièces jointes
                <span className="text-sm font-normal text-muted-foreground">({docItems.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {docItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucune pièce jointe.</p>
              ) : (
                <DocumentList documents={docItems} canDelete={l.instruit} canEdit={false} canRename={l.instruit} path={chemin} />
              )}
              {peutJoindre && <DocumentUpload entityType="PHARMACOVIGILANCE_CASE" entityId={cas.id} categories={["PHOTO", "SUPPORTING_DOC", "OTHER"]} compact />}
            </CardContent>
          </Card>

          {/* L'ÉCHANGE (Direction, 06/10) : le KAM, Regulatory et les personnes ajoutées ; les décisions (statut, enquête,
              participants) s'y inscrivent à leur place. */}
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><MessagesSquare className="h-4 w-4" /> Échange</CardTitle></CardHeader>
            <CardContent>
              <CommentThread
                comments={commentaires} action={commenterCasPv} hiddenFields={{ caseId: cas.id }} currentUserId={user.id}
                canModerate={l.instruit} updateAction={updateComment} deleteAction={deleteComment} path={chemin}
              />
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4 lg:col-span-1">
          {l.instruit && (
            <Card>
              <CardHeader><CardTitle>Instruction</CardTitle></CardHeader>
              <CardContent>
                <InstructionCasPv caseId={cas.id} status={status} suivants={[...statutsSuivantsPv(status)]} />
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Users className="h-4 w-4" /> Personnes dans l&apos;échange</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p><span className="text-muted-foreground">Déclarant :</span> <span className="font-medium">{nom(cas.reporterId)}</span></p>
              <ParticipantsCasPv caseId={cas.id} participants={participants} candidats={candidats} peutGerer={l.instruit} moi={user.id} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5 font-medium">{children}</div>
    </div>
  );
}
