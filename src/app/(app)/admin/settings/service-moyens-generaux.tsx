"use client";

import * as React from "react";
import { Loader2, Landmark } from "lucide-react";
import { useAction } from "@/components/shared/use-action";
import { Retour } from "@/components/ui/retour";
import { setGeneralMeansDepartment } from "@/lib/actions/general-means-service-actions";

/**
 * LE SERVICE DES MOYENS GÉNÉRAUX — quel département tient la caisse d'avance de la société.
 *
 * Ce réglage vivait sur l'écran des Moyens généraux (« Changer de service… ») ; le Super Admin l'a
 * retiré de là (24/11/2026) : l'écran montre la caisse du service, il ne la déplace pas. Il se règle
 * ici, avec les autres réglages de l'instance — Super Admin seul, revérifié par l'action et journalisé.
 * Changer de service ne déplace aucune somme : les caisses d'autres départements restent en base,
 * intactes, mais toute nouvelle remise ne vise plus que celle du service désigné.
 */
export function ServiceMoyensGenerauxForm({ departements, actuel }: {
  departements: { id: string; libelle: string }[];
  /** Le service désigné, s'il existe encore — `null` s'il n'a jamais été réglé ou a été supprimé. */
  actuel: string | null;
}) {
  const [choix, setChoix] = React.useState(actuel ?? "");
  const { busy, err, run } = useAction();
  const courant = departements.find((d) => d.id === actuel);
  const cible = departements.find((d) => d.id === choix);

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!cible || cible.id === actuel) return;
        const fd = new FormData(); fd.set("departmentId", cible.id);
        void run(() => setGeneralMeansDepartment(fd), undefined, {
          confirmer: {
            titre: `Faire de « ${cible.libelle} » le service des moyens généraux ?`,
            message: "C'est sa caisse d'avance que toute la société ouvrira, et elle seule recevra les remises.",
            confirmer: "Désigner",
          },
          succes: `« ${cible.libelle} » est désormais le service des moyens généraux.`,
        });
      }}
    >
      <p className="text-sm">
        {courant
          ? <>Service actuel : <strong>{courant.libelle}</strong></>
          : <span className="text-warning">Aucun service valide n&apos;est désigné : les Moyens généraux n&apos;ont pas de caisse.</span>}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="mg-service" className="sr-only">Département qui tient les moyens généraux</label>
        <select id="mg-service" value={choix} onChange={(e) => setChoix(e.target.value)} disabled={busy}
          className="h-10 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-base sm:h-9 sm:w-72 sm:text-sm">
          <option value="">— Département qui tient la caisse —</option>
          {departements.map((d) => <option key={d.id} value={d.id}>{d.libelle}</option>)}
        </select>
        <button type="submit" disabled={!cible || cible.id === actuel || busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Landmark className="h-4 w-4" />} Désigner
        </button>
      </div>
      <Retour ton="erreur">{err}</Retour>
    </form>
  );
}
