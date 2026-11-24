"use client";

import * as React from "react";
import { X } from "lucide-react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { ajouterMedecinsConcernes, retirerMedecinConcerne } from "../actions-medecins";
import { LIBELLE_ROLE_MEDECIN, type RoleMedecin } from "../domaine/medecins-concernes";
import { ChoixMedecinsAnnuaire } from "./choix-medecins-annuaire";

/**
 * « MÉDECINS CONCERNÉS » — des puces (nom, rôle) et, dessous, la liste déroulante de l'annuaire : on coche un ou plusieurs
 * praticiens, un bouton les relie tous avec le rôle choisi (recette 24/11/2026 — avant, deux lettres à taper et un médecin par
 * clic) ; la croix retire. Les médecins que le congrès porte déjà (invités, prises en charge) s'affichent sans croix :
 * ils se gèrent dans le congrès.
 */
export interface PuceMedecin {
  doctorId: string; nom: string; specialite: string | null; etablissement: string | null;
  role: RoleMedecin; montant: number | null; modifiable: boolean; origine: string | null;
}

export function MedecinsConcernesClient({ entityType, entityId, medecins, peutModifier }: {
  entityType: string; entityId: string; medecins: PuceMedecin[]; peutModifier: boolean;
}) {
  // `enCours` : tant que les puces fraîches ne sont pas à l'écran, la liste « déjà relié·e » est d'avant — on n'ajoute pas (§118.172).
  const { rafraichir, enCours } = useRafraichir();
  const [role, setRole] = React.useState<RoleMedecin>("BENEFICIAIRE");
  const [occupe, setOccupe] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const deja = React.useMemo(() => new Set(medecins.map((m) => m.doctorId)), [medecins]);

  async function envoyer(action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData): Promise<boolean> {
    setOccupe(true); setErreur(null);
    try {
      const r = await action(fd);
      if (!r.ok) { setErreur(r.error ?? "Échec de l'enregistrement."); return false; }
      rafraichir();
      return true;
    } catch {
      setErreur(actionFailureMessage("THROWN"));
      return false;
    } finally { setOccupe(false); }
  }

  const ajouter = (ids: string[]) => {
    const fd = new FormData();
    fd.set("entityType", entityType); fd.set("entityId", entityId); fd.set("role", role);
    for (const id of ids) fd.append("doctorIds", id);
    return envoyer(ajouterMedecinsConcernes, fd);
  };
  const retirer = (id: string) => {
    const fd = new FormData();
    fd.set("entityType", entityType); fd.set("entityId", entityId); fd.set("doctorId", id);
    void envoyer(retirerMedecinConcerne, fd);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {medecins.length === 0 && <span className="text-sm text-muted-foreground">Aucun médecin relié à l&apos;annuaire.</span>}
        {medecins.map((m) => (
          <span
            key={m.doctorId}
            className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-3 pr-1.5 text-sm text-primary sm:pl-2.5 sm:text-xs"
            title={[m.specialite, m.etablissement, m.origine].filter(Boolean).join(" · ") || undefined}
          >
            <a href={`/praticiens/${m.doctorId}`} className="min-w-0 truncate font-medium hover:underline">{m.nom}</a>
            <span className="shrink-0 text-primary/70">· {LIBELLE_ROLE_MEDECIN[m.role]}</span>
            {m.montant !== null && <span className="shrink-0 text-primary/70">· {Math.round(m.montant).toLocaleString("fr-FR")} DZD</span>}
            {peutModifier && m.modifiable && (
              <button
                type="button" disabled={occupe} onClick={() => retirer(m.doctorId)} aria-label={`Retirer ${m.nom}`}
                className="shrink-0 rounded-full p-2 hover:bg-primary/20 disabled:opacity-60 sm:p-1"
              >
                <X className="h-3.5 w-3.5 sm:h-3 sm:w-3" />
              </button>
            )}
          </span>
        ))}
      </div>

      {peutModifier && (
        <ChoixMedecinsAnnuaire deja={deja} role={role} onRole={setRole} occupe={occupe || enCours} onAjouter={ajouter} />
      )}
      {erreur && <p className="text-xs text-destructive" role="alert">{erreur}</p>}
    </div>
  );
}
