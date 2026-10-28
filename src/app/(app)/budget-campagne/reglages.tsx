"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { InfoBulle } from "@/components/ui/info-bulle";
import { cn } from "@/lib/utils";
import { DOMAINES_CAMPAGNE, LIBELLE_DOMAINE, SEUIL_JUSTIFICATION_DEFAUT } from "@/lib/budget-campagne/regles";
import type { CampagneVueDirection } from "@/lib/budget-campagne/vues";
import {
  creerCampagne, modifierCampagne, ajouterPoleCampagne, reglerPoleCampagne, retirerPoleCampagne,
} from "@/lib/actions/budget-campagne-actions";
import { CHEMIN_CAMPAGNE_BUDGETAIRE } from "@/lib/chemins/budget-campagne";
import { useActions, th, td, num, btn, btnPrimaire, champ } from "./commun";

type Opt = { id: string; name: string };

/**
 * LES RÉGLAGES D'UNE CAMPAGNE — tout est réglable par campagne (Direction : « beaucoup de flexibilité ») : dates, cadrage
 * (facultatif, PRIVÉ), valideurs (DG seul ou comité ; tous / un seul — défaut : DG + Super Admin, tous), seuil de
 * justification, rectificatif (Super Admin seul), pôles et leur domaine d'enveloppe.
 */
export function ReglagesCampagne({ mode, campagne, departements, valideursPossibles, voitLeCadrage, estSuperAdmin, campagnes, poles = [] }: {
  mode: "creation" | "edition";
  campagne: CampagneVueDirection | null;
  departements: Opt[];
  valideursPossibles: Opt[];
  voitLeCadrage: boolean;
  estSuperAdmin: boolean;
  campagnes: { id: string; title: string }[];
  poles?: { id: string; pole: string; domaine: string; cadrage: number | null; version: number }[];
}) {
  const router = useRouter();
  const { run, busy, info } = useActions();
  const annee = new Date().getFullYear() + 1;
  const jour = (iso?: string | null, defaut?: string) => (iso ? iso.slice(0, 10) : defaut ?? "");
  const [valideurs, setValideurs] = React.useState<string[]>(campagne?.validatorIds ?? []);
  const [poleIds, setPoleIds] = React.useState<string[]>([]);
  const [ajout, setAjout] = React.useState("");

  async function soumettre(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const champs: Record<string, string | string[]> = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string" && k !== "validatorIds" && k !== "poleIds") champs[k] = v;
    if (valideurs.length) champs.validatorIds = valideurs;
    if (mode === "creation") {
      champs.poleIds = poleIds;
      const r = await run(creerCampagne, champs);
      if (r.ok) router.push(CHEMIN_CAMPAGNE_BUDGETAIRE);
    } else if (campagne) {
      champs.id = campagne.id;
      // La case non cochée doit dire « non » : témoin explicite.
      if (estSuperAdmin) champs.allowRectificatif = fd.get("allowRectificatif") ? "on" : "off";
      await run(modifierCampagne, champs);
    }
  }

  const bascule = (liste: string[], set: (l: string[]) => void, id: string) => set(liste.includes(id) ? liste.filter((x) => x !== id) : [...liste, id]);
  const etiquette = "flex flex-col gap-1 text-sm";

  return (
    <div className="space-y-4">
      {info && <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{info}</p>}
      <form onSubmit={soumettre} className="surface space-y-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className={etiquette}>Titre<input name="title" className={champ} defaultValue={campagne?.title ?? `Campagne budgétaire ${annee}`} /></label>
          {mode === "creation" && <label className={etiquette}>Année<input name="year" type="number" className={champ} defaultValue={annee} required /></label>}
          <label className={etiquette}>Ouverture<input name="opensAt" type="date" className={champ} defaultValue={jour(campagne?.opensAt, `${annee - 1}-10-15`)} required /></label>
          <label className={etiquette}>Remise des propositions<input name="submitDeadline" type="date" className={champ} defaultValue={jour(campagne?.submitDeadline, `${annee - 1}-11-15`)} required /></label>
          <label className={etiquette}>Validation<input name="validationDeadline" type="date" className={champ} defaultValue={jour(campagne?.validationDeadline, `${annee - 1}-12-15`)} required /></label>
          <label className={etiquette}>
            <span className="flex items-center gap-1">Seuil de justification (%)<InfoBulle label="Seuil">Au-delà de cet écart avec le réalisé projeté, le pôle doit justifier la ligne.</InfoBulle></span>
            <input name="seuilJustificationPct" type="number" min={0} max={100} step="0.5" className={champ} defaultValue={campagne?.seuilJustificationPct ?? SEUIL_JUSTIFICATION_DEFAUT} />
          </label>
          {voitLeCadrage && (
            <label className={etiquette}>
              <span className="flex items-center gap-1">Cadrage global (DZD, facultatif)<InfoBulle label="Cadrage privé">L&apos;enveloppe du DG : visible du DG, des valideurs et du Super Admin seulement. Les pôles ne la voient jamais.</InfoBulle></span>
              <input name="cadrageTotal" inputMode="decimal" className={champ} defaultValue={campagne?.cadrageTotal ?? ""} />
            </label>
          )}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Validation</legend>
          <div className="flex flex-wrap gap-2">
            <select name="validatorMode" className={champ} defaultValue={campagne?.validatorMode ?? "COMITE"} aria-label="Mode de validation">
              <option value="COMITE">Comité</option><option value="DG">Le DG seul</option>
            </select>
            <select name="validatorRule" className={champ} defaultValue={campagne?.validatorRule ?? "ALL"} aria-label="Règle de validation">
              <option value="ALL">Tous les valideurs</option><option value="ANY">Un seul valideur suffit</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {valideursPossibles.map((u) => (
              <label key={u.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={valideurs.includes(u.id)} onChange={() => bascule(valideurs, setValideurs, u.id)} /> {u.name}</label>
            ))}
          </div>
          {mode === "creation" && valideurs.length === 0 && <p className="text-xs text-muted-foreground">Aucun coché : le DG et le Super Admin.</p>}
        </fieldset>

        {estSuperAdmin && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="allowRectificatif" defaultChecked={campagne?.allowRectificatif ?? false} />
            Budgets rectificatifs permis pour toute la campagne
            <InfoBulle label="Rectificatif">Par défaut, non : un budget validé ne bouge plus, sauf révision autorisée par le Super Admin, proposition par proposition.</InfoBulle>
          </label>
        )}

        {mode === "creation" && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Pôles (départements de l&apos;organigramme)</legend>
            <div className="flex max-h-56 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
              {departements.map((d) => (
                <label key={d.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={poleIds.includes(d.id)} onChange={() => bascule(poleIds, setPoleIds, d.id)} /> {d.name}</label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {campagnes.length > 0 && <Link href={CHEMIN_CAMPAGNE_BUDGETAIRE} className={btn}>Retour</Link>}
          <button type="submit" className={btnPrimaire} disabled={busy}>{mode === "creation" ? "Créer la campagne" : "Enregistrer"}</button>
        </div>
      </form>

      {mode === "edition" && campagne && (
        <section className="surface overflow-hidden">
          <header className="border-b border-border px-4 py-3"><h2 className="text-base font-semibold">Pôles</h2></header>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead><tr><th className={th}>Pôle</th><th className={th}>Enveloppe créée dans</th>{voitLeCadrage && <th className={cn(th, num)}>Cadrage du pôle (privé)</th>}<th className={th} /></tr></thead>
              <tbody>
                {poles.map((p) => (
                  <tr key={p.id}>
                    <td className={td}>{p.pole}</td>
                    <td className={td}>
                      <select className={champ} defaultValue={p.domaine} aria-label={`Domaine — ${p.pole}`} onChange={(e) => void run(reglerPoleCampagne, { proposalId: p.id, domaine: e.target.value })}>
                        {DOMAINES_CAMPAGNE.map((d) => <option key={d} value={d}>{LIBELLE_DOMAINE[d]}</option>)}
                      </select>
                    </td>
                    {voitLeCadrage && (
                      <td className={cn(td, num)}>
                        <input className={cn(champ, "w-36 text-right")} inputMode="decimal" defaultValue={p.cadrage ?? ""} aria-label={`Cadrage — ${p.pole}`}
                          onBlur={(e) => { if (e.target.value !== String(p.cadrage ?? "")) void run(reglerPoleCampagne, { proposalId: p.id, cadrage: e.target.value }); }} />
                      </td>
                    )}
                    <td className={td}>
                      {p.version === 0 && <button type="button" className={btn} disabled={busy} onClick={() => void run(retirerPoleCampagne, { proposalId: p.id }, { confirmer: `Retirer « ${p.pole} » ?` })}>Retirer</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
            <select className={champ} value={ajout} onChange={(e) => setAjout(e.target.value)} aria-label="Département à ajouter">
              <option value="">— Ajouter un pôle —</option>
              {departements.filter((d) => !poles.some((p) => p.pole === d.name)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button type="button" className={btn} disabled={busy || !ajout} onClick={() => void run(ajouterPoleCampagne, { campaignId: campagne.id, departmentId: ajout }).then((r) => r.ok && setAjout(""))}>Ajouter</button>
          </div>
        </section>
      )}
    </div>
  );
}
