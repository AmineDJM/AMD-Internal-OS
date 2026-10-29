import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { capacites, chercherDocuments, etatDeLaFile } from "@/modules/bibliotheque/api";
import { FormulaireBibliotheque, ResultatsBibliotheque, type ParamsRecherche } from "@/modules/bibliotheque/ecrans/recherche";
import { LireMaintenant } from "@/modules/bibliotheque/ecrans/geste-super-admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bibliothèque — AMD Internal OS" };

const un = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? undefined;

const STATUTS: Record<string, string> = { A_FAIRE: "à lire", EN_COURS: "en lecture", FAITE: "lues", IGNOREE: "sans texte", ECHEC: "en échec" };

/**
 * LA BIBLIOTHÈQUE (J1) — l'écran de VÉRIFICATION de la recherche par le contenu : toute pièce entrée dans la
 * plateforme (Drive, messagerie, pièces des dossiers, RH, réunions, rapports terrain…), retrouvée par ce qu'elle
 * dit, et seulement si la personne peut l'ouvrir. L'outil n'est pas encore branché dans l'Assistant IA ni Adam.
 */
export default async function BibliothequePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const p: ParamsRecherche = { q: un(sp.q), format: un(sp.format), source: un(sp.source), du: un(sp.du), au: un(sp.au) };
  const r = await chercherDocuments(user, p.q ?? "", { formats: p.format, sources: p.source, du: p.du, au: p.au });
  const superAdmin = user.role === "SUPER_ADMIN";
  const [file, cap] = superAdmin ? await Promise.all([etatDeLaFile(), capacites()]) : [null, null];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Bibliothèque"
        description="Toutes les pièces de la plateforme, retrouvées par leur contenu — seulement celles que vous pouvez ouvrir."
      >
        {superAdmin && <LireMaintenant />}
      </PageHeader>
      <FormulaireBibliotheque p={p} />
      {superAdmin && file && cap && (
        <p className="text-xs text-muted-foreground">
          File : {Object.entries(file).map(([s, n]) => `${n} ${STATUTS[s] ?? s}`).join(" · ") || "vide"}
          {" — "}recherche {cap.vecteur ? "hybride (plein texte, titre, sens)" : "plein texte et titre (pgvector absent)"}
          {r.mode.vecteur && !r.mode.vecteurUtilise && p.q ? " ; le sens n'a pas servi à cette requête (fournisseur indisponible)" : ""}
          {r.ecartesParLesDroits ? ` ; ${r.ecartesParLesDroits} candidat(s) écarté(s) par les droits` : ""}
        </p>
      )}
      <ResultatsBibliotheque resultats={r.resultats} requete={p.q ?? ""} />
    </div>
  );
}
