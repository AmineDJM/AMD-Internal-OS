"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { LIBELLE_ETAT_BUREAU, type LigneBureau } from "@/lib/secretariat/ligne-bureau";
import { correspondRecherche, echeanceAffichee, masqueeParDefaut, JOURS_TERMINEES_VISIBLES } from "@/lib/secretariat/tableau-bureau";

/**
 * LE TABLEAU DU BUREAU DU SECRÉTARIAT (maquette validée le 24/11/2026) — une ligne par demande, quelle que soit sa
 * famille : Type, Objet (et sa référence), Demandeur, Dates, État, Chez qui, Échéance. UNE recherche ; aucun onglet,
 * aucune tuile, aucun filtre : l'ordre est celui du serveur (`trierLignesBureau`). La ligne entière ouvre sa fiche.
 * Les closes de plus de trente jours se masquent, et le pied le dit.
 */
export function TableauBureau({ lignes, maintenant }: {
  lignes: LigneBureau[];
  /** L'heure du rendu SERVEUR : le serveur et le navigateur lisent les retards sur la même minute. */
  maintenant: number;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [toutes, setToutes] = React.useState(false);

  const trouvees = lignes.filter((l) => correspondRecherche(l, q));
  const masquees = toutes ? 0 : trouvees.filter((l) => masqueeParDefaut(l, maintenant)).length;
  const affichees = toutes ? trouvees : trouvees.filter((l) => !masqueeParDefaut(l, maintenant));

  return (
    <section aria-label="Toutes les demandes" className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3 sm:px-5">
        <label htmlFor="cherche-bureau" className="sr-only">Rechercher une demande</label>
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            id="cherche-bureau" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher : objet, référence, demandeur, personne…"
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {affichees.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          {q.trim() ? "Aucune demande ne correspond à cette recherche." : "Aucune demande pour l'instant. « + Nouvelle demande » en dépose une."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="bg-secondary/40 text-left text-xs text-muted-foreground">
                <th scope="col" className="px-5 py-2 font-semibold">Type</th>
                <th scope="col" className="px-3 py-2 font-semibold">Objet</th>
                <th scope="col" className="px-3 py-2 font-semibold">Demandeur</th>
                <th scope="col" className="px-3 py-2 font-semibold">Dates</th>
                <th scope="col" className="px-3 py-2 font-semibold">État</th>
                <th scope="col" className="px-3 py-2 font-semibold">Chez qui</th>
                <th scope="col" className="px-5 py-2 font-semibold">Échéance</th>
              </tr>
            </thead>
            <tbody>
              {affichees.map((l) => {
                const ech = echeanceAffichee(l, maintenant);
                return (
                  <tr
                    key={l.cle}
                    onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) router.push(l.href); }}
                    className={cn("cursor-pointer border-t border-border align-top hover:bg-secondary/30", l.etat === "A_PRENDRE" && "bg-primary/[0.04]")}
                  >
                    <td className="px-5 py-3 font-semibold">{l.type}</td>
                    <td className="px-3 py-3">
                      <Link href={l.href} className="font-semibold text-primary hover:underline [overflow-wrap:anywhere]">{l.objet}</Link>
                      {l.reference && <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{l.reference}</span>}
                    </td>
                    <td className="px-3 py-3">{l.demandeur ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-3">{l.dates ?? "—"}</td>
                    <td className="px-3 py-3">{LIBELLE_ETAT_BUREAU[l.etat]}</td>
                    <td className="px-3 py-3 [overflow-wrap:anywhere]">{l.chezQui ?? "—"}</td>
                    <td className={cn("whitespace-nowrap px-5 py-3", ech.retard && "font-semibold text-destructive")}>{ech.texte}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
        {affichees.length} demande{affichees.length > 1 ? "s" : ""}
        {toutes
          ? " — toutes les terminées sont affichées."
          : ` — les terminées depuis plus de ${JOURS_TERMINEES_VISIBLES} jours sont masquées.`}
        {masquees > 0 && (
          <> <button type="button" onClick={() => setToutes(true)} className="font-medium text-primary hover:underline">Voir plus de terminées ({masquees})</button></>
        )}
        {toutes && (
          <> <button type="button" onClick={() => setToutes(false)} className="font-medium text-primary hover:underline">Masquer les anciennes</button></>
        )}
      </p>
    </section>
  );
}
