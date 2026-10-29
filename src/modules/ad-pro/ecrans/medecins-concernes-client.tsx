"use client";

import * as React from "react";
import { Loader2, Search, X } from "lucide-react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { ajouterMedecinConcerne, chercherMedecinsAnnuaire, retirerMedecinConcerne } from "../actions-medecins";
import { LIBELLE_ROLE_MEDECIN, ROLES_MEDECIN, type RoleMedecin } from "../domaine/medecins-concernes";

/**
 * « MÉDECINS CONCERNÉS » — des puces (nom, rôle) et un champ de recherche dans l'annuaire. Un clic sur un résultat l'ajoute avec
 * le rôle choisi ; la croix retire. Les médecins que le congrès porte déjà (invités, prises en charge) s'affichent sans croix :
 * ils se gèrent dans le congrès.
 */
export interface PuceMedecin {
  doctorId: string; nom: string; specialite: string | null; etablissement: string | null;
  role: RoleMedecin; montant: number | null; modifiable: boolean; origine: string | null;
}

interface Resultat { id: string; nom: string; specialite: string | null; etablissement: string | null }

export function MedecinsConcernesClient({ entityType, entityId, medecins, peutModifier }: {
  entityType: string; entityId: string; medecins: PuceMedecin[]; peutModifier: boolean;
}) {
  const { rafraichir } = useRafraichir();
  const [q, setQ] = React.useState("");
  const [role, setRole] = React.useState<RoleMedecin>("BENEFICIAIRE");
  const [resultats, setResultats] = React.useState<Resultat[]>([]);
  const [cherche, setCherche] = React.useState(false);
  const [occupe, setOccupe] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const deja = React.useMemo(() => new Set(medecins.map((m) => m.doctorId)), [medecins]);

  React.useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setResultats([]); return; }
    let annule = false;
    setCherche(true);
    const minuteur = setTimeout(async () => {
      const fd = new FormData();
      fd.set("q", t);
      try {
        const r = await chercherMedecinsAnnuaire(fd);
        if (!annule) setResultats(r);
      } finally {
        if (!annule) setCherche(false);
      }
    }, 250);
    return () => { annule = true; clearTimeout(minuteur); };
  }, [q]);

  async function envoyer(action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData) {
    setOccupe(true); setErreur(null);
    try {
      const r = await action(fd);
      if (!r.ok) setErreur(r.error ?? "Échec de l'enregistrement.");
      else { setQ(""); setResultats([]); rafraichir(); }
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally { setOccupe(false); }
  }

  const ajouter = (id: string) => {
    const fd = new FormData();
    fd.set("entityType", entityType); fd.set("entityId", entityId); fd.set("doctorId", id); fd.set("role", role);
    void envoyer(ajouterMedecinConcerne, fd);
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
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher dans l'annuaire (nom, spécialité, établissement)…"
                aria-label="Chercher un médecin dans l'annuaire"
                className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-2.5 text-sm"
              />
              {cherche && <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />}
            </div>
            <select
              value={role} onChange={(e) => setRole(e.target.value as RoleMedecin)} aria-label="Rôle du médecin"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              {ROLES_MEDECIN.map((r) => <option key={r} value={r}>{LIBELLE_ROLE_MEDECIN[r]}</option>)}
            </select>
          </div>
          {resultats.length > 0 && (
            <ul className="max-h-56 divide-y divide-border overflow-auto rounded-md border border-border text-sm">
              {resultats.map((r) => (
                <li key={r.id}>
                  <button
                    type="button" disabled={occupe || deja.has(r.id)} onClick={() => ajouter(r.id)}
                    className="flex w-full flex-col items-start gap-0.5 px-2.5 py-2 text-left hover:bg-secondary disabled:opacity-50"
                  >
                    <span className="font-medium">{r.nom}{deja.has(r.id) ? " — déjà relié·e" : ""}</span>
                    <span className="text-xs text-muted-foreground">{[r.specialite, r.etablissement].filter(Boolean).join(" · ") || "—"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {q.trim().length >= 2 && !cherche && resultats.length === 0 && (
            <p className="text-xs text-muted-foreground">Aucun praticien trouvé dans l&apos;annuaire.</p>
          )}
        </div>
      )}
      {erreur && <p className="text-xs text-destructive" role="alert">{erreur}</p>}
    </div>
  );
}
