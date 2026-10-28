import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { LIBELLE_PRISE_EN_CHARGE, lireFichePersonne, LIBELLE_ROLE, LIBELLE_SOURCE } from "@/modules/referentiels/api";

export const dynamic = "force-dynamic";
export const metadata = { title: "Personne — AMD Internal OS" };

/**
 * LA FICHE PERSONNE 360° (refonte des données, lot V2-B) — en lecture. Chaque bloc ne montre que les lignes
 * dont l'écran d'origine s'ouvrirait à la même personne (`referentiels/personnes/fiche.ts`) ; une Personne
 * qu'on ne voit nulle part ailleurs n'existe pas ici (404). Aucune donnée sensible : elles sont au coffre.
 */
export default async function FichePersonnePage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  const lecture = await lireFichePersonne(user, params.id);
  if (lecture.etat === "FUSIONNEE") redirect(`/personnes/${lecture.versId}`);
  if (lecture.etat === "ABSENTE") notFound();
  const p = lecture.fiche;
  const nom = [p.civilite, p.prenoms, p.nom].filter(Boolean).join(" ");

  return (
    <div className="space-y-5">
      <PageHeader
        title={nom}
        description={[p.naissance ? `né(e) le ${formatDate(p.naissance)}` : null, p.nationalite, `fiche complète à ${p.completude} %`].filter(Boolean).join(" · ")}
      />
      {p.roles.length > 0 && (
        <div className="flex flex-wrap gap-2">{p.roles.map((r) => <Badge key={r} tone="info">{LIBELLE_ROLE[r]}</Badge>)}</div>
      )}

      <Bloc titre="Fiches dans l'ERP" vide="Aucune fiche visible.">
        {p.fiches.map((f) => (
          <Ligne key={`${f.source}:${f.id}`} lien={f.lien} titre={f.libelle} sous={[LIBELLE_SOURCE[f.source], f.detail].filter(Boolean).join(" · ")} />
        ))}
      </Bloc>

      {p.affiliations.length > 0 && (
        <Bloc titre="Affiliations">
          {p.affiliations.map((a) => (
            <Ligne key={a.id} titre={a.organisation} sous={[a.fonction, a.service, a.principale ? "principale" : null].filter(Boolean).join(" · ")} />
          ))}
        </Bloc>
      )}

      {p.prisesEnCharge.length > 0 && (
        <Bloc titre="Prises en charge">
          {p.prisesEnCharge.map((c) => <Ligne key={c.id} lien={c.lien} titre={c.operation} sous={LIBELLE_PRISE_EN_CHARGE[c.statut]} />)}
        </Bloc>
      )}

      {p.voyages.length > 0 && (
        <Bloc titre="Voyages et hébergements">
          {p.voyages.map((v) => (
            <Ligne
              key={v.id} lien={v.lien}
              titre={`${v.nature === "VOL" ? "Voyage" : "Hôtel"} — ${v.poste}`}
              sous={[v.trajet, v.du ? `du ${formatDate(v.du)}` : null, v.au ? `au ${formatDate(v.au)}` : null].filter(Boolean).join(" ")}
            />
          ))}
        </Bloc>
      )}

      {p.pieces.length > 0 && (
        <Bloc titre="Pièces liées">
          {p.pieces.map((x) => <Ligne key={x.id} lien={x.lien} titre={x.nom} sous={[x.nature, `déposée le ${formatDate(x.deposeeLe)}`].filter(Boolean).join(" · ")} />)}
        </Bloc>
      )}

      {p.fusionnees.length > 0 && (
        <Bloc titre="Fiches absorbées par fusion">
          {p.fusionnees.map((f) => <Ligne key={f.id} lien={`/personnes/${f.id}`} titre={f.nom} sous="fusionnée dans celle-ci" />)}
        </Bloc>
      )}
    </div>
  );
}

function Bloc({ titre, vide, children }: { titre: string; vide?: string; children: React.ReactNode }) {
  const lignes = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <section className="surface min-w-0 space-y-2 p-3 sm:p-4">
      <h2 className="text-sm font-semibold">{titre}</h2>
      {lignes.length ? <ul className="divide-y divide-border">{children}</ul> : <p className="text-sm text-muted-foreground">{vide}</p>}
    </section>
  );
}

function Ligne({ titre, sous, lien }: { titre: string; sous?: string | null; lien?: string | null }) {
  return (
    <li className="min-w-0 py-2 text-sm [overflow-wrap:anywhere]">
      {lien ? <Link href={lien} className="font-medium text-primary hover:underline">{titre}</Link> : <span className="font-medium">{titre}</span>}
      {sous && <p className="text-xs text-muted-foreground">{sous}</p>}
    </li>
  );
}
