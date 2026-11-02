import { ArrowLeft } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { CONTRACT_LABEL, STAGE_LABEL, isRecruitmentContract, type RecruitmentStage } from "@/lib/recruitment/request-flow";
import { lignes } from "@/lib/site-web/contrat";
import { posteOuvert } from "@/lib/site-web/contenus";
import { peutPublierOffres } from "@/lib/site-web/acces";
import { recruitmentScope } from "@/lib/recruitment/access";
import { OffreForm, type OffreEditee } from "@/components/site-web/offre-form";
import { disponibiliteRedaction } from "@/lib/redaction-site-ia";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nouvelle offre d'emploi — AMD Internal OS" };

/**
 * PRÉPARER UNE OFFRE — libre, ou depuis une demande de recrutement (`?demande=`).
 *
 * Depuis une demande, l'offre reprend l'intitulé, la direction, le contrat, les missions et les
 * compétences. JAMAIS la rémunération ni la justification : ce sont des données internes, et la
 * liste des champs repris est écrite ici, champ par champ — rien n'est recopié « en bloc ».
 */
export default async function NouvelleOffrePage(props: { searchParams?: Promise<{ demande?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  if (user.mustChangePassword) redirect("/change-password");
  if (!peutPublierOffres(user)) notFound();

  let offre: OffreEditee = {
    id: null, title: "", department: "", location: "", contractLabel: "", experience: "", summary: "",
    mission: "", profile: "", offer: "", published: false,
  };
  let demande: { id: string; reference: string; poste: string; etape: string; ouvert: boolean } | null = null;

  const demandeId = searchParams?.demande;
  if (demandeId) {
    // La demande se lit sous la porte du RECRUTEMENT, pas seulement sous celle des offres. Les deux
    // disent aujourd'hui la même chose (RH en écriture, ou la direction) ; c'est une coïncidence
    // entre deux copies, pas une règle : le jour où l'une s'élargit — la communication qui publie
    // les offres, par exemple —, `?demande=` montrerait les missions d'un poste qu'on n'a pas le
    // droit d'ouvrir. Composée en `AND` : la portée porte un `OR` (§118.133). Une demande hors
    // portée rend la même page qu'une demande inexistante.
    const r = await prisma.recruitmentRequest.findFirst({
      where: { AND: [{ id: demandeId }, recruitmentScope(user)] },
      select: {
        id: true, reference: true, position: true, contractType: true, missions: true, skills: true, stage: true,
        department: { select: { name: true } }, jobPosting: { select: { id: true } },
      },
    });
    if (!r) notFound();
    // Une demande porte UNE offre : on renvoie vers celle qui existe au lieu d'en ouvrir une seconde.
    if (r.jobPosting) redirect(`/site-web/offres/${r.jobPosting.id}`);
    const stage = r.stage as RecruitmentStage;
    demande = { id: r.id, reference: r.reference, poste: r.position, etape: STAGE_LABEL[stage] ?? r.stage, ouvert: posteOuvert(r.stage) };
    offre = {
      ...offre,
      title: r.position,
      department: r.department?.name ?? "",
      contractLabel: isRecruitmentContract(r.contractType) ? CONTRACT_LABEL[r.contractType] : "",
      mission: lignes(r.missions).join("\n"),
      profile: lignes(r.skills).join("\n"),
    };
  }

  const ia = await disponibiliteRedaction();

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <BackLink href={demande ? `/recrutement/${demande.id}` : "/site-web/offres"}>
        <ArrowLeft className="h-4 w-4" /> {demande ? "Retour au recrutement" : "Offres d'emploi"}
      </BackLink>
      <PageHeader
        title={demande ? `Offre pour « ${demande.poste} »` : "Nouvelle offre d'emploi"}
        description="Elle reste un brouillon, invisible du site, tant que vous ne la publiez pas."
      />
      <OffreForm
        offre={offre}
        dejaEnvoye={false}
        etat={null}
        demande={demande}
        peutEcrire
        peutSupprimer={false}
        prerempliDepuisDemande={demande !== null}
        ia={ia}
      />
    </div>
  );
}
