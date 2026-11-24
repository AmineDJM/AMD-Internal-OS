"use client";

import * as React from "react";
import { X } from "lucide-react";
import { apercuReleve, importTransactions, type LigneApercuReleve } from "@/modules/finances/actions-tresorerie";
import { useAction } from "@/components/shared/use-action";
import { Retour } from "@/components/ui/retour";
import { cn, formatCurrency } from "@/lib/utils";
import { dateCourte } from "./format";
import { BoutonPrincipal, BoutonSecondaire, Champ, Pastilles } from "./elements";

type Etape = { k: "choix" } | { k: "apercu"; entete: string; lignes: LigneApercuReleve[] } | { k: "fait"; bilan: string; sansPiece: number };

/**
 * IMPORTER UN RELEVÉ (CSV) — choisir le compte et le fichier, VOIR CHAQUE LIGNE (lue, écartée et pourquoi, déjà au livre),
 * décocher ce qui ne doit pas entrer, importer. La lecture est celle de l'import (`apercuReleve` → `lireLigneReleve`) :
 * l'aperçu ne promet rien que l'import ne tiendrait pas. Seules les lignes cochées partent.
 */
export function PanneauImport({ comptes, onFermer, onVoirSansJustif }: {
  comptes: { id: string; nom: string }[]; onFermer: () => void; onVoirSansJustif: () => void;
}) {
  const [compte, setCompte] = React.useState(comptes[0]?.id ?? "");
  const [fichier, setFichier] = React.useState<File | null>(null);
  const [etape, setEtape] = React.useState<Etape>({ k: "choix" });
  const [exclues, setExclues] = React.useState<Set<number>>(new Set());
  const lecture = useAction();
  const envoi = useAction();
  const entree = React.useRef<HTMLInputElement>(null);

  const voirApercu = () => lecture.run(async () => {
    if (!fichier) return { ok: false, error: "Choisissez d'abord le fichier du relevé." };
    const fd = new FormData();
    fd.set("csv", await fichier.text());
    const r = await apercuReleve(fd);
    if (r.ok && r.lignes) {
      // Une ligne illisible ou déjà au livre arrive décochée : l'importer échouerait, ou doublerait l'écriture.
      setExclues(new Set(r.lignes.filter((l) => !l.ok || l.deja).map((l) => l.numero)));
      setEtape({ k: "apercu", entete: r.entete ?? "", lignes: r.lignes });
    }
    return { ok: r.ok, error: r.error };
  });

  const retenues = etape.k === "apercu" ? etape.lignes.filter((l) => l.ok && !exclues.has(l.numero)) : [];
  const importer = () => {
    if (etape.k !== "apercu") return;
    void envoi.run(async () => {
      const fd = new FormData();
      fd.set("csv", [etape.entete, ...retenues.map((l) => l.texte)].join("\n"));
      if (compte) fd.set("treasuryAccountId", compte);
      const r = await importTransactions(undefined, fd);
      if (r.ok) setEtape({ k: "fait", bilan: r.message ?? "Import terminé.", sansPiece: retenues.filter((l) => l.sens === "OUT").length });
      return r;
    });
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2.5">
        <h2 className="text-[19px] font-bold">Importer un relevé</h2>
        <button type="button" onClick={onFermer} aria-label="Fermer l'import" className="inline-flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg border border-border">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {etape.k === "choix" && (
        <>
          {comptes.length > 0 && <Champ libelle="Compte du relevé"><Pastilles options={comptes.map((c) => ({ valeur: c.id, libelle: c.nom }))} valeur={compte} onChoix={setCompte} /></Champ>}
          <input ref={entree} type="file" accept=".csv,text/csv,text/plain" className="sr-only" aria-label="Fichier CSV du relevé" onChange={(x) => setFichier(x.target.files?.[0] ?? null)} />
          <button
            type="button" onClick={() => entree.current?.click()}
            className={cn("min-h-16 rounded-[10px] p-3 text-sm font-semibold", fichier ? "border border-success bg-success/10 text-success" : "border-2 border-dashed border-border bg-muted/40 text-primary")}
          >
            {fichier ? `✓ ${fichier.name} · changer` : "Choisir le fichier CSV du relevé…"}
          </button>
          <p className="text-xs text-muted-foreground">Colonnes : <code>date, direction, category, label, amount, method, account, counterparty</code></p>
          <Retour ton="erreur">{lecture.err}</Retour>
          <BoutonPrincipal onClick={voirApercu} disabled={!fichier || lecture.busy} className="h-10">Voir l&apos;aperçu</BoutonPrincipal>
        </>
      )}

      {etape.k === "apercu" && (
        <>
          <p className="text-[13px] text-muted-foreground">{fichier?.name} · {comptes.find((c) => c.id === compte)?.nom ?? "compte de chaque ligne"} · {etape.lignes.length} ligne{etape.lignes.length > 1 ? "s" : ""} lue{etape.lignes.length > 1 ? "s" : ""}</p>
          <ul className="flex flex-col gap-1.5">
            {etape.lignes.map((l) => {
              const incluse = l.ok && !exclues.has(l.numero);
              const note = !l.ok ? `Écartée · ligne ${l.numero} — ${l.raison}` : l.deja ? `Déjà au livre · ${l.deja} · ignorée` : l.sens === "IN" ? "Nouvelle recette" : "Nouvelle dépense · justificatif à joindre";
              return (
                <li key={l.numero} className={cn("flex items-start gap-2.5 rounded-lg border border-border px-2.5 py-2", incluse ? "bg-card" : "bg-muted/50 opacity-70")}>
                  <input
                    type="checkbox" checked={incluse} disabled={!l.ok} aria-label={`Inclure la ligne ${l.numero}`} className="mt-0.5 h-[18px] w-[18px] flex-none"
                    onChange={() => setExclues((s) => { const n = new Set(s); if (n.has(l.numero)) n.delete(l.numero); else n.add(l.numero); return n; })}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex justify-between gap-2 text-[13px]">
                      <span className="text-muted-foreground">{l.date ? dateCourte(l.date) : "—"}</span>
                      {l.montant !== null && <strong className={l.sens === "IN" ? "text-success" : ""}>{l.sens === "IN" ? "+ " : "− "}{formatCurrency(l.montant)}</strong>}
                    </span>
                    <span className="mt-0.5 block font-mono text-xs [overflow-wrap:anywhere]">{l.libelle}</span>
                    <span className={cn("mt-0.5 block text-xs font-semibold", !l.ok ? "text-destructive" : l.deja ? "text-muted-foreground" : l.sens === "OUT" ? "text-destructive" : "text-success")}>{note}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <Retour ton="erreur">{envoi.err}</Retour>
          <div className="flex justify-end gap-2">
            <BoutonSecondaire onClick={() => { setEtape({ k: "choix" }); setFichier(null); }}>Changer de fichier</BoutonSecondaire>
            <BoutonPrincipal onClick={importer} disabled={envoi.busy || retenues.length === 0} className="h-10">
              Importer {retenues.length} ligne{retenues.length > 1 ? "s" : ""}
            </BoutonPrincipal>
          </div>
        </>
      )}

      {etape.k === "fait" && (
        <>
          <div className="rounded-[10px] bg-success/10 px-3.5 py-3 text-sm font-semibold text-success">{etape.bilan}</div>
          {etape.sansPiece > 0 && (
            <div className="rounded-[10px] bg-destructive/5 px-3.5 py-3 text-[13px] font-semibold text-destructive">
              {etape.sansPiece} dépense{etape.sansPiece > 1 ? "s" : ""} sans justificatif : {etape.sansPiece > 1 ? "elles apparaissent" : "elle apparaît"} dans « Sans justificatif ».
            </div>
          )}
          <div className="flex justify-end gap-2">
            {etape.sansPiece > 0 && <BoutonSecondaire onClick={onVoirSansJustif} className="h-10">Voir les sans justificatif</BoutonSecondaire>}
            <BoutonPrincipal onClick={onFermer} className="h-10">Terminer</BoutonPrincipal>
          </div>
        </>
      )}
    </>
  );
}
