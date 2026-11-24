import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, Clock } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { LIBELLE_ETAPE_FILE, type LigneFileAgence } from "@/modules/ad-pro/api";

/**
 * UNE FILE DU PARCOURS AGENCE — d'abord ce qui est À VOUS, puis le reste, chaque ligne avec son étape en clair et un seul lien.
 * Utilisée par « Suivi des agences » (Direction Marketing, Super Admin) et « Contrôles de conformité » (information médicale).
 *
 * La file « Suivi des agences » porte le GESTE de la ligne (« Déposer les devis des agences »…) et, quand ce n'est pas à
 * vous, CHEZ QUI en est le poste — la phrase même de la carte. Une ligne qui ne les porte pas (conformité) garde l'étape et
 * l'action de la page. `entre` : ce qui se lit entre les deux blocs ; `aides` : une phrase
 * sous chaque titre.
 */
export function ListeAgences({ lignes, vide, action, entre = null, aides }: {
  lignes: LigneFileAgence[]; vide: string; action: string; entre?: ReactNode; aides?: { aMoi: string; autres: string };
}) {
  if (lignes.length === 0) return <div className="space-y-5"><EmptyState icon="CircleCheck" title={vide} />{entre}</div>;
  const aMoi = lignes.filter((l) => l.aMoi);
  const autres = lignes.filter((l) => !l.aMoi);
  const bloc = (titre: string, aide: string | undefined, ls: LigneFileAgence[], accent: boolean) => ls.length > 0 && (
    <section className="space-y-2" aria-label={titre}>
      <div>
        <h2 className="text-sm font-semibold">{titre} <span className="font-normal text-muted-foreground">({ls.length})</span></h2>
        {aide && <p className="text-xs text-muted-foreground">{aide}</p>}
      </div>
      <ul className="space-y-2">
        {ls.map((l) => (
          <li key={l.itemId}>
            <Link href={l.lien} className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 hover:bg-secondary/50 ${accent ? "border-primary/40 bg-primary/[0.03]" : "border-border bg-card"}`}>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{l.label} <span className="font-normal text-muted-foreground">· {l.nature}</span></span>
                <span className="block text-xs text-muted-foreground">{l.ref}{l.assistante ? ` · ${l.assistante}` : ""} · depuis le {new Date(l.depuis).toLocaleDateString("fr-FR")}</span>
                {!accent && l.attente && (
                  <span className="mt-1 flex items-start gap-1 text-xs"><Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /> <span>{l.attente}</span></span>
                )}
                {(accent || !l.attente) && l.cahierDesCharges && <span className="mt-1 block text-xs [overflow-wrap:anywhere]">{l.cahierDesCharges.slice(0, 160)}</span>}
              </span>
              {/* À VOUS : le geste lui-même est le bouton ; sinon l'étape, en pastille. */}
              {accent && l.geste ? (
                <span className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">{l.geste} <ArrowRight className="h-4 w-4" /></span>
              ) : (
                <>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${accent ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground"}`}>{LIBELLE_ETAPE_FILE[l.etape]}</span>
                  {accent && <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">{action} <ArrowRight className="h-4 w-4" /></span>}
                </>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <div className="space-y-5">
      {bloc("À vous", aides?.aMoi, aMoi, true)}
      {entre}
      {bloc("En cours ailleurs", aides?.autres, autres, false)}
    </div>
  );
}
