"use client";

import * as React from "react";
import { X } from "lucide-react";
import { createTransaction } from "@/modules/finances/actions-tresorerie";
import { CATEGORIES_SAISIE, REFUS_DEPENSE_SANS_JUSTIFICATIF, TYPES_PIECE } from "@/modules/finances/partage";
import { useAction } from "@/components/shared/use-action";
import { FINANCE_CATEGORY } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { aujourdhuiAlger } from "./format";
import { BoutonPrincipal, BoutonSecondaire, Champ, Pastilles } from "./elements";

const SANS_SOCIETE = "sans";

/**
 * « NOUVELLE ÉCRITURE » / « ENREGISTRER UN ENCAISSEMENT » — la saisie de la maquette, servie par `createTransaction`.
 * Une DÉPENSE exige son justificatif : l'écran le dit avant d'envoyer, et le serveur le refuse de toute façon (la règle
 * vit dans `refusDepenseSansJustificatif`, la même des deux côtés). La société est celle de l'écran.
 */
export function PanneauSaisie({ encaissement, societeId, comptes, budgets, onFermer, onEnregistree }: {
  encaissement: boolean;
  societeId: string;
  comptes: { id: string; nom: string }[];
  budgets: { id: string; libelle: string }[];
  onFermer: () => void;
  onEnregistree: (id: string, vue: "dep" | "rec") => void;
}) {
  const [sens, setSens] = React.useState<"OUT" | "IN">(encaissement ? "IN" : "OUT");
  const [date, setDate] = React.useState(aujourdhuiAlger());
  const [montant, setMontant] = React.useState("");
  const [tiers, setTiers] = React.useState("");
  const [objet, setObjet] = React.useState("");
  const [compte, setCompte] = React.useState(comptes[0]?.id ?? "");
  const [categorie, setCategorie] = React.useState(encaissement ? "RECETTE" : "");
  const [typePiece, setTypePiece] = React.useState(TYPES_PIECE[encaissement ? "IN" : "OUT"][0]!.libelle);
  const [fichier, setFichier] = React.useState<File | null>(null);
  const [budget, setBudget] = React.useState("");
  const [erreurs, setErreurs] = React.useState<string[]>([]);
  const act = useAction();
  const entree = React.useRef<HTMLInputElement>(null);
  const estDep = sens === "OUT";

  const changerSens = (s: "OUT" | "IN") => {
    setSens(s); setCategorie(s === "IN" ? "RECETTE" : ""); setTypePiece(TYPES_PIECE[s][0]!.libelle); setBudget(""); setErreurs([]);
  };

  const enregistrer = () => {
    const err: string[] = [];
    const n = Number(montant.replace(/[\s  ]/g, "").replace(",", "."));
    if (!(n > 0)) err.push("Indiquez le montant.");
    if (!tiers.trim()) err.push(estDep ? "Indiquez à qui la dépense est payée." : "Indiquez de qui vient la recette.");
    if (!categorie) err.push("Choisissez une catégorie.");
    if (estDep && !fichier) err.push(REFUS_DEPENSE_SANS_JUSTIFICATIF);
    setErreurs(err);
    if (err.length) return;
    const c = comptes.find((x) => x.id === compte);
    void act.run(async () => {
      const fd = new FormData();
      for (const [k, v] of Object.entries({
        date, direction: sens, category: categorie, label: objet.trim() || FINANCE_CATEGORY[categorie] || categorie, amount: String(n),
        counterparty: tiers.trim(), treasuryAccountId: compte, account: c?.nom ?? "Banque",
        method: /caisse/i.test(c?.nom ?? "") ? "CASH" : "BANK_TRANSFER", status: "SETTLED",
        companyId: societeId === SANS_SOCIETE ? "" : societeId, typePiece, budgetCategoryId: estDep ? budget : "",
      })) fd.set(k, v);
      if (fichier) fd.set("justificatif", fichier);
      const r = await createTransaction(undefined, fd);
      if (r.ok && r.id) onEnregistree(r.id, estDep ? "dep" : "rec");
      return r;
    }, undefined, { succes: "Écriture enregistrée." });
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2.5">
        <h2 className="text-[19px] font-bold">{encaissement ? "Enregistrer un encaissement" : "Nouvelle écriture"}</h2>
        <button type="button" onClick={onFermer} aria-label="Fermer le formulaire" className="inline-flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg border border-border">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div role="group" aria-label="Sens" className="grid grid-cols-2 gap-1 rounded-[9px] bg-secondary p-1">
        {([["OUT", "Dépense"], ["IN", "Recette"]] as const).map(([k, l]) => (
          <button
            key={k} type="button" onClick={() => changerSens(k)} aria-pressed={sens === k}
            className={cn("h-9 rounded-md text-sm", sens === k ? cn("bg-card font-bold shadow-sm", k === "IN" && "text-success") : "text-muted-foreground")}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Champ id="saisie-date" libelle="Date"><input id="saisie-date" type="date" value={date} onChange={(x) => setDate(x.target.value)} className="h-10 rounded-lg border border-border bg-background px-2.5 text-sm" /></Champ>
        <Champ id="saisie-montant" libelle="Montant (DZD)">
          <input id="saisie-montant" inputMode="decimal" value={montant} onChange={(x) => { setMontant(x.target.value); setErreurs([]); }} placeholder="0" className="h-10 rounded-lg border border-border bg-background px-2.5 text-sm font-semibold" />
        </Champ>
      </div>
      <Champ id="saisie-tiers" libelle={estDep ? "Payé à" : "Reçu de"}>
        <input id="saisie-tiers" value={tiers} onChange={(x) => { setTiers(x.target.value); setErreurs([]); }} placeholder={estDep ? "Fournisseur, organisme, salarié…" : "Client, PCH, banque…"} className="h-10 rounded-lg border border-border bg-background px-2.5 text-sm" />
      </Champ>
      <Champ id="saisie-objet" libelle="Objet">
        <input id="saisie-objet" value={objet} onChange={(x) => setObjet(x.target.value)} className="h-10 rounded-lg border border-border bg-background px-2.5 text-sm" />
      </Champ>
      {comptes.length > 0 && <Champ libelle="Compte"><Pastilles options={comptes.map((c) => ({ valeur: c.id, libelle: c.nom }))} valeur={compte} onChoix={setCompte} /></Champ>}
      <Champ libelle="Catégorie">
        <Pastilles options={CATEGORIES_SAISIE[sens].map((c) => ({ valeur: c, libelle: FINANCE_CATEGORY[c] ?? c }))} valeur={categorie} onChoix={(c) => { setCategorie(c); setErreurs([]); }} />
      </Champ>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-muted-foreground">
          Justificatif <span className={cn("text-xs font-semibold", estDep ? "text-destructive" : "text-muted-foreground")}>{estDep ? "obligatoire" : "conseillé"}</span>
        </span>
        <Pastilles options={TYPES_PIECE[sens].map((t) => ({ valeur: t.libelle, libelle: t.libelle }))} valeur={typePiece} onChoix={setTypePiece} />
        <input ref={entree} type="file" accept=".pdf,image/*" className="sr-only" aria-label="Fichier du justificatif" onChange={(x) => { setFichier(x.target.files?.[0] ?? null); setErreurs([]); }} />
        <button
          type="button" onClick={() => (fichier ? setFichier(null) : entree.current?.click())}
          className={cn("min-h-14 rounded-[10px] p-2.5 text-sm font-semibold",
            fichier ? "border border-success bg-success/10 text-success"
            : estDep && erreurs.length ? "border-2 border-dashed border-destructive bg-destructive/5 text-destructive"
            : "border-2 border-dashed border-border bg-muted/40 text-primary")}
        >
          {fichier ? `✓ ${fichier.name} · retirer` : "Déposer ou choisir le fichier (PDF, photo)…"}
        </button>
      </div>
      {estDep && budgets.length > 0 && (
        <Champ id="saisie-budget" libelle="Budget imputé">
          <select id="saisie-budget" value={budget} onChange={(x) => setBudget(x.target.value)} className="h-10 rounded-lg border border-border bg-background px-2 text-sm">
            <option value="">Non imputé</option>
            {budgets.map((b) => <option key={b.id} value={b.id}>{b.libelle}</option>)}
          </select>
        </Champ>
      )}
      {(erreurs.length > 0 || act.err) && (
        <ul className="flex list-disc flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 py-2.5 pl-7 pr-3 text-[13px] font-semibold text-destructive">
          {erreurs.map((e) => <li key={e}>{e}</li>)}
          {act.err && <li>{act.err}</li>}
        </ul>
      )}
      <div className="flex justify-end gap-2 border-t border-border/60 pt-3">
        <BoutonSecondaire onClick={onFermer}>Annuler</BoutonSecondaire>
        <BoutonPrincipal onClick={enregistrer} disabled={act.busy}>Enregistrer</BoutonPrincipal>
      </div>
    </>
  );
}
