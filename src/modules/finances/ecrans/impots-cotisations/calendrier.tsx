"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import {
  COMPOSITIONS_FISCALES, LIBELLE_COMPOSITION, LIBELLE_PERIODICITE, PERIODICITES_FISCALES, suivanteDansLeCycle,
  type CompositionFiscale, type PeriodiciteFiscale,
} from "../../domaine/impots";
import type { ObligationVue } from "../../infra/impots";
import { enregistrerCalendrierFiscal } from "../../actions-impots";
import { champ, dateCourte, EnTetePanneau, Note, nomSociete, Pastille, type Annoncer, type Societe } from "./commun";

/**
 * LE CALENDRIER DES ÉCHÉANCES — par société : organisme, nature, composition, périodicité, jour limite, rappel J-7, et
 * la confirmation du jour par les Finances. La plateforme ne contient aucun calendrier fiscal : c'est CE tableau qui
 * fait naître les lignes « À préparer » et les rappels. Rien n'est prérempli.
 */

interface LigneCal {
  cle: string;
  id?: string;
  companyId: string;
  organisme: string;
  nature: string;
  composition: CompositionFiscale;
  periodicite: PeriodiciteFiscale;
  jour: string;
  /** Une obligation annuelle : le mois de l'année suivante (« 4 » = avril). */
  mois: string;
  rappel: boolean;
  confirme: boolean;
  confirmeTexte: string | null;
  /** Ajoutée par « l'IBS de l'année » : dates proposées, à confirmer par le cabinet. */
  proposee?: boolean;
}

/**
 * LES OBLIGATIONS USUELLES (Super Admin et audit des dépenses, 24/11/2026) — pré-inscrites d'un geste, réglables, NON
 * confirmées tant que le cabinet ne les a pas validées : l'IBS (acomptes selon l'avis, et le SOLDE — liquidation annuelle —
 * proposé au 30 avril de l'année suivante), puis les sous-natures des autres taxes. Les pénalités, elles, se paient en
 * ponctuel : elles n'ont pas d'échéance à prévoir.
 */
const OBLIGATIONS_USUELLES: readonly { organisme: string; nature: string; periodicite: PeriodiciteFiscale; jour: string; mois: string }[] = [
  { organisme: "Recette des impôts", nature: "Acompte IBS", periodicite: "SELON_AVIS", jour: "", mois: "" },
  { organisme: "Recette des impôts", nature: "Solde IBS (liquidation annuelle)", periodicite: "ANNUELLE", jour: "30", mois: "4" },
  { organisme: "CASNOS", nature: "CASNOS — cotisation des gérants non salariés", periodicite: "ANNUELLE", jour: "", mois: "" },
  { organisme: "Recette des impôts", nature: "TFP et taxe d'apprentissage", periodicite: "ANNUELLE", jour: "", mois: "" },
  { organisme: "Recette des impôts", nature: "Retenues à la source", periodicite: "MENSUELLE", jour: "", mois: "" },
  { organisme: "Recette des impôts", nature: "Taxe foncière", periodicite: "ANNUELLE", jour: "", mois: "" },
  { organisme: "Recette des impôts", nature: "Vignettes automobiles", periodicite: "ANNUELLE", jour: "", mois: "" },
  { organisme: "Recette des impôts", nature: "Droits de timbre et d'enregistrement", periodicite: "SELON_AVIS", jour: "", mois: "" },
];

const depuis = (o: ObligationVue): LigneCal => ({
  cle: o.id, id: o.id, companyId: o.companyId, organisme: o.organisme, nature: o.nature, composition: o.composition,
  periodicite: o.periodicite, jour: o.jourLimite ? String(o.jourLimite) : "", mois: o.moisLimite ? String(o.moisLimite) : "", rappel: o.rappel, confirme: o.confirme,
  confirmeTexte: o.confirme ? `Confirmé${o.confirmePar ? ` par ${o.confirmePar}` : ""} · ${dateCourte(o.confirmeLe)}` : null,
});

export function PanneauCalendrier({ calendrier, societes, societeCourante, peutModifier, onFermer, annoncer }: {
  calendrier: ObligationVue[]; societes: Societe[]; societeCourante: string | null; peutModifier: boolean; onFermer: () => void; annoncer: Annoncer;
}) {
  const { busy, err, setErr, run } = useAction();
  const dansLaPortee = (c: string) => !societeCourante || c === societeCourante;
  const [lignes, setLignes] = React.useState<LigneCal[]>(() => calendrier.filter((o) => dansLaPortee(o.companyId)).map(depuis));
  const [retirees, setRetirees] = React.useState<string[]>([]);
  const nouvelle = React.useRef(0);
  React.useEffect(() => {
    setLignes(calendrier.filter((o) => !societeCourante || o.companyId === societeCourante).map(depuis));
    setRetirees([]);
  }, [calendrier, societeCourante]);

  const pose = (cle: string, patch: Partial<LigneCal>) => {
    setLignes((ls) => ls.map((l) => (l.cle === cle ? { ...l, ...patch } : l)));
    setErr(null);
  };
  const ajouter = () => {
    nouvelle.current += 1;
    setLignes((ls) => [...ls, {
      cle: `n${nouvelle.current}`, companyId: societeCourante ?? societes[0]?.id ?? "", organisme: "", nature: "",
      composition: "MONTANT", periodicite: "MENSUELLE", jour: "", mois: "", rappel: true, confirme: false, confirmeTexte: null,
    }]);
  };
  const societeIbs = societeCourante ?? societes[0]?.id ?? "";
  const usuellesAbsentes = OBLIGATIONS_USUELLES.filter((m) => !lignes.some((l) => l.companyId === societeIbs && l.nature.trim().toLowerCase() === m.nature.toLowerCase()));
  const ajouterUsuelles = () => {
    setLignes((ls) => [...ls, ...OBLIGATIONS_USUELLES
      .filter((m) => !ls.some((l) => l.companyId === societeIbs && l.nature.trim().toLowerCase() === m.nature.toLowerCase()))
      .map((m) => {
        nouvelle.current += 1;
        return { cle: `n${nouvelle.current}`, companyId: societeIbs, composition: "MONTANT" as const, rappel: true, confirme: false, confirmeTexte: null, proposee: true, ...m };
      })]);
  };
  const retirer = (l: LigneCal) => {
    setLignes((ls) => ls.filter((x) => x.cle !== l.cle));
    if (l.id) setRetirees((r) => [...r, l.id!]);
  };
  const enregistrer = () => run(async () => {
    const fd = new FormData();
    fd.set("lignes", JSON.stringify(lignes.map(({ id, companyId, organisme, nature, composition, periodicite, jour, mois, rappel, confirme }) => ({ id, companyId, organisme, nature, composition, periodicite, jour, mois, rappel, confirme }))));
    fd.set("retirees", JSON.stringify(retirees));
    const r = await enregistrerCalendrierFiscal(fd);
    if (r.ok && r.message) annoncer(r.message);
    return r;
  });
  const portee = societeCourante ? nomSociete(societes.find((s) => s.id === societeCourante)) : "toutes vos sociétés";

  return (
    <div className="flex flex-col gap-3.5">
      <EnTetePanneau surtitre={`Paramètres · ${portee}`} titre="Calendrier des échéances" onFermer={onFermer} />
      <Note>
        <strong>Jours limites à confirmer par les Finances.</strong> La plateforme ne contient aucun calendrier fiscal : c&apos;est ce tableau
        qu&apos;elle utilise pour créer chaque période les lignes « À préparer » et envoyer les rappels. Tant qu&apos;un jour n&apos;est pas
        confirmé, la liste l&apos;affiche « à confirmer ».
      </Note>

      {lignes.length === 0 && <p className="text-sm text-muted-foreground">Aucune échéance au calendrier{societeCourante ? ` de ${portee}` : ""}. Ajoutez la première : organisme, nature, jour limite.</p>}

      <ul className="flex flex-col gap-2.5">
        {lignes.map((l) => (
          <li key={l.cle} className="flex flex-col gap-2.5 rounded-lg border border-border p-3">
            {societes.length > 1 && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Société">
                {societes.map((s) => (
                  <Pastille key={s.id} actif={l.companyId === s.id} disabled={!peutModifier || Boolean(l.id)} onClick={() => pose(l.cle, { companyId: s.id })}>{nomSociete(s)}</Pastille>
                ))}
              </div>
            )}
            <div className={l.periodicite === "ANNUELLE" ? "grid grid-cols-1 gap-2 sm:grid-cols-4" : "grid grid-cols-1 gap-2 sm:grid-cols-3"}>
              <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">Organisme
                <input type="text" value={l.organisme} placeholder="ex. CNAS" disabled={!peutModifier} onChange={(e) => pose(l.cle, { organisme: e.target.value })} className={champ} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">Nature
                <input type="text" value={l.nature} placeholder="ex. Cotisations sociales" disabled={!peutModifier} onChange={(e) => pose(l.cle, { nature: e.target.value })} className={champ} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">Jour limite (mois suivant)
                <input type="text" inputMode="numeric" value={l.jour} placeholder="à renseigner" disabled={!peutModifier} onChange={(e) => pose(l.cle, { jour: e.target.value, confirme: false, confirmeTexte: null })} className={champ} />
              </label>
              {l.periodicite === "ANNUELLE" && (
                <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">Mois limite (année suivante)
                  <input type="text" inputMode="numeric" value={l.mois} placeholder="1 = janvier" disabled={!peutModifier} onChange={(e) => pose(l.cle, { mois: e.target.value, confirme: false, confirmeTexte: null })} className={champ} />
                </label>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={!peutModifier} aria-label="Changer la périodicité" onClick={() => pose(l.cle, { periodicite: suivanteDansLeCycle(PERIODICITES_FISCALES, l.periodicite) })}
                className="h-9 rounded-full border border-border bg-card px-3 text-sm disabled:opacity-60">Périodicité : <strong>{LIBELLE_PERIODICITE[l.periodicite]}</strong> ↻</button>
              <button type="button" disabled={!peutModifier} aria-label="Changer la décomposition" onClick={() => pose(l.cle, { composition: suivanteDansLeCycle(COMPOSITIONS_FISCALES, l.composition) })}
                className="h-9 rounded-full border border-border bg-card px-3 text-sm disabled:opacity-60">Lignes : <strong>{LIBELLE_COMPOSITION[l.composition]}</strong> ↻</button>
              <Pastille actif={l.rappel} disabled={!peutModifier} onClick={() => pose(l.cle, { rappel: !l.rappel })}>{l.rappel ? "Rappel J-7 : oui" : "Rappel J-7 : non"}</Pastille>
              <Badge tone={l.confirme ? "success" : l.jour.trim() || l.periodicite === "SELON_AVIS" ? "warning" : "danger"}>
                {l.confirme ? (l.confirmeTexte ?? "Confirmé par vous") : l.proposee ? "Proposé — à confirmer par le cabinet" : l.jour.trim() || l.periodicite === "SELON_AVIS" ? "À confirmer" : "Jour à renseigner"}
              </Badge>
              <span className="flex-1" />
              {peutModifier && (
                <>
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => (l.jour.trim() || l.periodicite === "SELON_AVIS"
                      ? pose(l.cle, { confirme: !l.confirme, confirmeTexte: null })
                      : setErr(`Renseignez d'abord le jour limite de « ${l.nature || "cette échéance"} ».`))}>
                    {l.confirme ? "Annuler la confirmation" : "Confirmer ce jour"}
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="text-destructive" aria-label="Retirer cette échéance" onClick={() => retirer(l)}>Retirer</Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      <Retour>{err}</Retour>

      {peutModifier && (
        <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-3.5">
          <span className="flex flex-wrap gap-2">
            <button type="button" onClick={ajouter} className="h-11 rounded-lg border border-dashed border-border bg-card px-3.5 text-sm font-semibold text-primary">+ Ajouter une échéance</button>
            {usuellesAbsentes.length > 0 && societeIbs && (
              <button type="button" onClick={ajouterUsuelles} className="h-11 rounded-lg border border-dashed border-border bg-card px-3.5 text-sm font-semibold text-primary">
                + Obligations usuelles (IBS, CASNOS, TFP…)
              </button>
            )}
          </span>
          <Button type="button" size="lg" disabled={busy} onClick={() => void enregistrer()}>Enregistrer le calendrier</Button>
        </div>
      )}
    </div>
  );
}
