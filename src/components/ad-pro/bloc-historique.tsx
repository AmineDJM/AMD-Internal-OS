import { History, Landmark, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SessionUser } from "@/lib/rbac";
import { blocHistoriqueDe } from "@/lib/budget-marketing/integration-serveur";
import { BADGE_HISTORIQUE, formatCentimes, type TypeDemandeIntegree } from "@/lib/budget-marketing/integration-2026";
import { PiecesHistorique, RelierEcriture } from "./pieces-historique";

const dzd = (n: number) => `${formatCentimes(Math.round(n * 100)) || "0"} DZD`;
const jour = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");

/**
 * LE BLOC « HISTORIQUE 2026 » D'UNE DEMANDE AD & PRO (intégration des dépenses réelles, maquette validée).
 *
 * Posé en tête des fiches (sponsoring, congrès, événement, matériel promotionnel, information médicale, et la fiche
 * d'intégration d'une formation). Il ne rend RIEN pour une demande qu'aucun lot actif ne porte. Pour une demande créée
 * par le lot : le badge, « Demandé par : Direction Marketing », et le rappel qu'aucun circuit ne s'applique ; pour toutes :
 * les postes payés (montant, date, imputation, ligne du fichier), l'écriture de trésorerie reliée (lecture seule) et son
 * écart, les pièces attendues / manquantes avec le dépôt multi-fichiers, à tout moment.
 */
export async function BlocHistorique({ user, type, id }: { user: SessionUser; type: TypeDemandeIntegree; id: string }) {
  const bloc = await blocHistoriqueDe(user, type, id);
  if (!bloc) return null;
  return (
    <section id="historique-2026" className="surface space-y-3 rounded-xl border-purple-200 p-4 text-sm">
      <header className="flex flex-wrap items-center gap-2">
        <History className="h-4 w-4 text-purple-700" />
        {bloc.badge ? <Badge tone="purple">{BADGE_HISTORIQUE}</Badge> : <Badge tone="info">Complétée par l&apos;intégration 2026</Badge>}
        <span className="text-xs text-muted-foreground">Fichier « Dépenses AP », ligne{bloc.lignes.length > 1 ? "s" : ""} {bloc.lignes.map((l) => `L${l}`).join(" + ")}</span>
        <span className="ml-auto font-semibold tabular-nums">{dzd(bloc.montant)}</span>
      </header>
      {bloc.demandeurAffiche && <p><span className="text-muted-foreground">Demandé par :</span> <strong>{bloc.demandeurAffiche}</strong></p>}
      {bloc.badge && (
        <p className="text-xs text-muted-foreground">
          Déjà réalisée et payée : cette demande ne repasse par aucun circuit — ni validation, ni bon de commande à générer, ni centre de paiement,
          ni ordre de dépense. Elle garde tout le reste : postes, pièces, imputation, discussion{bloc.fichesVoyageurs ? ", fiches voyageurs" : ""}.
        </p>
      )}

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Postes payés</h3>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {bloc.postes.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1">{p.libelle}{p.repris && <span className="text-xs text-muted-foreground"> (poste existant, complété)</span>}</span>
              <span className="text-xs text-muted-foreground">{p.imputation ?? "—"} · payé le {jour(p.payeLe)}{p.ligne ? ` · L${p.ligne}` : ""}</span>
              <Badge tone="success">payé</Badge>
              <span className="tabular-nums">{dzd(p.montant)}</span>
            </li>
          ))}
        </ul>
      </div>

      {bloc.ecriture && (
        <p className="flex flex-wrap items-center gap-1 text-xs">
          <Landmark className="h-3.5 w-3.5 text-muted-foreground" />
          Écriture de trésorerie reliée (lecture seule) : <strong>{bloc.ecriture.reference}</strong>, {dzd(bloc.ecriture.montant)} le {jour(bloc.ecriture.date)}.
          {bloc.ecriture.ecart !== 0 && <span className="text-warning"> Écart affiché : {dzd(Math.abs(bloc.ecriture.ecart))} — le budget retient {dzd(bloc.montant)}, comme décidé.</span>}
        </p>
      )}

      {bloc.peutJoindre && <RelierEcriture demandeRowId={bloc.demandeRowId} actuelle={bloc.ecriture?.reference ?? null} />}

      {bloc.fichesVoyageurs && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" /> Les fiches voyageurs s&apos;ajoutent à tout moment, dans la section des professionnels pris en charge.</p>
      )}

      <PiecesHistorique
        demandeRowId={bloc.demandeRowId} pieces={bloc.pieces} manquantes={bloc.manquantes}
        rattachables={bloc.rattachables} peutJoindre={bloc.peutJoindre}
      />
    </section>
  );
}
