import { ArrowLeft } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { formatDateTime } from "@/lib/utils";
import { STAGE_LABEL, type RecruitmentStage } from "@/lib/recruitment/request-flow";
import { etatAffiche, publicationsDe, suspensionEnVigueur } from "@/lib/site-web/etat";
import { posteOuvert } from "@/lib/site-web/contenus";
import { peutPublierOffres, peutVoirOffres } from "@/lib/site-web/acces";
import { OffreForm } from "@/components/site-web/offre-form";
import { disponibiliteRedaction } from "@/lib/redaction-site-ia";
import { RepriseNote } from "@/components/site-web/reprise";

export const dynamic = "force-dynamic";
export const metadata = { title: "Offre d'emploi — AMD Internal OS" };

/** UNE OFFRE — son texte, ses contrôles, son recrutement, et son état SUR LE SITE. */
export default async function OffrePage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireUser();
  if (user.mustChangePassword) redirect("/change-password");
  if (!peutVoirOffres(user)) notFound();
  const o = await prisma.jobPosting.findUnique({
    where: { id: params.id },
    include: {
      createdBy: { select: { name: true } }, updatedBy: { select: { name: true } },
      recruitmentRequest: { select: { id: true, reference: true, position: true, stage: true } },
      reprise: { select: { origine: true, cleSite: true, titre: true, createdAt: true } },
    },
  });
  if (!o) notFound();
  const [pubs, suspendu, ia] = await Promise.all([publicationsDe("JOB", [o.id]), suspensionEnVigueur(), disponibiliteRedaction()]);
  const pub = pubs.get(o.id) ?? null;
  const etat = etatAffiche(pub, o.published, suspendu);
  const r = o.recruitmentRequest;
  const publie = peutPublierOffres(user);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <BackLink href="/site-web/offres"><ArrowLeft className="h-4 w-4" /> Offres d&apos;emploi</BackLink>
      <PageHeader
        title={o.title}
        description={`Créée${o.createdBy ? ` par ${o.createdBy.name}` : ""} le ${formatDateTime(o.createdAt)} · modifiée${o.updatedBy ? ` par ${o.updatedBy.name}` : ""} le ${formatDateTime(o.updatedAt)}`}
      />
      <RepriseNote reprise={o.reprise} dejaEnvoye={pub !== null} />
      <OffreForm
        offre={{
          id: o.id, title: o.title, department: o.department ?? "", location: o.location ?? "", contractLabel: o.contractLabel ?? "",
          experience: o.experience ?? "", summary: o.summary ?? "", mission: o.mission.join("\n"), profile: o.profile.join("\n"),
          offer: o.offer.join("\n"), published: o.published,
        }}
        dejaEnvoye={pub !== null}
        etat={{ libelle: etat.libelle, ton: etat.ton, detail: etat.detail, lien: etat.lien }}
        demande={r ? { id: r.id, reference: r.reference, poste: r.position, etape: STAGE_LABEL[r.stage as RecruitmentStage] ?? r.stage, ouvert: posteOuvert(r.stage) } : null}
        peutEcrire={publie}
        peutSupprimer={publie}
        ia={ia}
      />
    </div>
  );
}
