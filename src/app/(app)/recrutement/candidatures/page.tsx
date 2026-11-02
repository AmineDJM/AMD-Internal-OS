import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, FileText, Mail, Phone } from "lucide-react";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import { recruitmentScope } from "@/lib/recruitment/access";
import { peutTraiterCandidaturesSite, type EtatCandidature } from "@/lib/site-web/candidatures";
import { GestesCandidature } from "./gestes-candidature";

export const dynamic = "force-dynamic";
export const metadata = { title: "Candidatures du site — AMD Internal OS" };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BOÎTE D'ARRIVÉE DES CANDIDATURES DU SITE (§118.159) — pour les RH et la direction.
 *
 * Une candidature déposée pour une offre dont le poste est OUVERT entre d'elle-même dans son
 * recrutement : elle n'arrive ici que pour mémoire (« Rattachées »). Toutes les autres — spontanées,
 * offre sans recrutement, poste déjà pourvu — attendent ici qu'une personne décide, avec la RAISON
 * pour laquelle elles ne sont pas entrées seules. Rien n'est deviné : rattacher une candidature
 * spontanée à un poste est un choix de recruteur (§118.34).
 *
 * Un CV est une donnée personnelle : l'écran ne s'ouvre qu'à la porte du tri
 * (`peutTraiterCandidaturesSite`), la même que l'action et que la route qui sert le fichier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ONGLETS: { etat: EtatCandidature; libelle: string }[] = [
  { etat: "NOUVELLE", libelle: "À trier" },
  { etat: "RATTACHEE", libelle: "Entrées dans un recrutement" },
  { etat: "CLASSEE", libelle: "Classées" },
];

function tailleLisible(octets: number | null): string {
  if (!octets) return "";
  return octets >= 1024 * 1024 ? `${(octets / (1024 * 1024)).toFixed(1)} Mo` : `${Math.max(1, Math.round(octets / 1024))} Ko`;
}

export default async function CandidaturesDuSitePage(props: { searchParams: Promise<{ etat?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("RECRUITMENT");
  if (!peutTraiterCandidaturesSite(user)) notFound();

  const etat: EtatCandidature = ONGLETS.some((o) => o.etat === searchParams.etat) ? (searchParams.etat as EtatCandidature) : "NOUVELLE";
  const [candidatures, compteurs, postesOuverts] = await Promise.all([
    prisma.siteCandidature.findMany({
      where: { etat },
      orderBy: { recueLe: "desc" },
      take: 200,
      select: {
        id: true, nom: true, email: true, telephone: true, message: true, offreTitre: true, cvCle: true, cvNom: true,
        cvTaille: true, etat: true, motif: true, soumiseLe: true, recueLe: true, traiteeLe: true, traiteeParId: true,
        candidate: { select: { requestId: true, request: { select: { reference: true, position: true } } } },
      },
    }),
    prisma.siteCandidature.groupBy({ by: ["etat"], _count: { _all: true } }),
    prisma.recruitmentRequest.findMany({
      where: { AND: [recruitmentScope(user), { stage: "SOURCING" as const }] },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, reference: true, position: true },
    }),
  ]);
  const traitants = [...new Set(candidatures.map((c) => c.traiteeParId).filter((x): x is string => Boolean(x)))];
  const noms = new Map(
    (traitants.length ? await prisma.user.findMany({ where: { id: { in: traitants } }, select: { id: true, name: true } }) : [])
      .map((u) => [u.id, u.name] as const),
  );
  const nombre = (e: EtatCandidature) => compteurs.find((c) => c.etat === e)?._count._all ?? 0;
  const options = postesOuverts.map((p) => ({ value: p.id, label: `${p.reference} — ${p.position}` }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Candidatures du site"
        description="Les candidatures déposées sur adventumdz.com. Celles d'un poste ouvert entrent d'elles-mêmes dans son recrutement ; les autres attendent ici votre décision."
      >
        <Link href="/recrutement"><Button size="sm" variant="outline"><ArrowLeft className="h-4 w-4" /> Recrutement</Button></Link>
      </PageHeader>

      <nav className="flex flex-wrap gap-2" aria-label="État des candidatures">
        {ONGLETS.map((o) => (
          <Link
            key={o.etat}
            href={o.etat === "NOUVELLE" ? "/recrutement/candidatures" : `/recrutement/candidatures?etat=${o.etat}`}
            aria-current={o.etat === etat ? "page" : undefined}
            className={o.etat === etat
              ? "rounded-full bg-primary px-3 py-2 text-sm font-medium text-primary-foreground sm:py-1.5"
              : "rounded-full border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-secondary sm:py-1.5"}
          >
            {o.libelle} ({nombre(o.etat)})
          </Link>
        ))}
      </nav>

      {candidatures.length === 0 ? (
        <EmptyState
          icon="Inbox"
          title={etat === "NOUVELLE" ? "Aucune candidature à trier" : "Rien ici pour l'instant"}
          description={etat === "NOUVELLE"
            ? "Les candidatures déposées sur le site arrivent ici dès que le candidat clique « Envoyer » — sauf celles d'un poste ouvert, qui entrent directement dans leur recrutement."
            : undefined}
        />
      ) : (
        <ul className="space-y-3">
          {candidatures.map((c) => (
            <li key={c.id} className="surface space-y-3 p-3 sm:p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="break-words text-base font-semibold">{c.nom}</p>
                  <p className="text-sm text-muted-foreground">
                    {c.offreTitre ? <>Pour « {c.offreTitre} »</> : "Candidature spontanée"} · reçue le {formatDateTime(c.recueLe)}
                  </p>
                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    <a href={`mailto:${c.email}`} className="inline-flex min-w-0 items-center gap-1 break-all py-1 text-primary hover:underline">
                      <Mail className="h-3.5 w-3.5 shrink-0" /> {c.email}
                    </a>
                    {c.telephone && (
                      <a href={`tel:${c.telephone.replace(/[^+\d]/g, "")}`} className="inline-flex items-center gap-1 py-1 text-primary hover:underline">
                        <Phone className="h-3.5 w-3.5 shrink-0" /> {c.telephone}
                      </a>
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {c.etat === "RATTACHEE" && <Badge tone="success" dot>Dans un recrutement</Badge>}
                  {c.etat === "CLASSEE" && <Badge tone="neutral" dot>Classée</Badge>}
                  {c.etat === "NOUVELLE" && <Badge tone="warning" dot>À trier</Badge>}
                </div>
              </div>

              {c.motif && c.etat !== "RATTACHEE" && <p className="rounded-lg bg-secondary/50 px-3 py-2 text-sm">{c.motif}</p>}
              {c.message && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">Message du candidat</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words">{c.message}</p>
                </details>
              )}

              <div className="flex flex-wrap items-center gap-2 text-sm">
                {c.cvCle && c.etat !== "RATTACHEE" ? (
                  <>
                    <a href={`/api/site-web/candidatures/${c.id}/cv`} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 py-1 text-primary [overflow-wrap:anywhere] hover:underline">
                      <FileText className="h-4 w-4 shrink-0" /> {c.cvNom ?? "CV"} {c.cvTaille ? <span className="text-muted-foreground">({tailleLisible(c.cvTaille)})</span> : null}
                    </a>
                    <a href={`/api/site-web/candidatures/${c.id}/cv?dl=1`} className="inline-flex items-center gap-1 py-1 text-muted-foreground hover:underline">
                      <Download className="h-4 w-4" /> Télécharger
                    </a>
                  </>
                ) : !c.cvCle ? (
                  <span className="text-muted-foreground">Sans CV joint.</span>
                ) : null}
                {c.etat === "RATTACHEE" && c.candidate && (
                  <Link href={`/recrutement/${c.candidate.requestId}`} className="text-primary hover:underline">
                    {c.candidate.request.reference} — {c.candidate.request.position} (le CV est sur sa fiche)
                  </Link>
                )}
                {c.etat === "RATTACHEE" && !c.candidate && <span className="text-muted-foreground">Le candidat a été retiré de son recrutement.</span>}
                {c.traiteeLe && (
                  <span className="text-xs text-muted-foreground">
                    · traitée le {formatDateTime(c.traiteeLe)}{c.traiteeParId ? ` par ${noms.get(c.traiteeParId) ?? "un compte supprimé"}` : " automatiquement"}
                  </span>
                )}
              </div>

              {(c.etat === "NOUVELLE" || c.etat === "CLASSEE" || (c.etat === "RATTACHEE" && !c.candidate)) && (
                <GestesCandidature id={c.id} etat={c.etat as EtatCandidature} postesOuverts={options} nom={c.nom} orpheline={c.etat === "RATTACHEE" && !c.candidate} />
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        Les candidatures sont envoyées par le site au moment où le candidat clique « Envoyer ». Le consentement au traitement de ses
        données est exigé par le site ET revérifié ici ; « Effacer » supprime la candidature et son CV (droit à l&apos;oubli).
      </p>
    </div>
  );
}
