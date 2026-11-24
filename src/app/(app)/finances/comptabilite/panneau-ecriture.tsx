"use client";

import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Loader2, X } from "lucide-react";
import type { DetailEcriture } from "@/modules/finances/api";
import { CATEGORIES_SAISIE, MOTIFS_CONTRE_PASSATION, origineSansDossier, TYPES_PIECE } from "@/modules/finances/partage";
import { updateTransaction, deleteTransaction } from "@/modules/finances/actions-tresorerie";
import { contrePasserEcriture, demanderPieceEcriture, joindreJustificatifEcriture } from "@/modules/finances/actions-comptabilite";
import { useAction } from "@/components/shared/use-action";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Retour } from "@/components/ui/retour";
import { FINANCE_CATEGORY } from "@/lib/labels";
import { cn, formatCurrency } from "@/lib/utils";
import type { DroitsCompta } from "./ecran-comptabilite";
import { dateCourte, dateLongue } from "./format";
import { Pastilles, Champ, BoutonPrincipal, BoutonSecondaire, TitreBloc } from "./elements";

// L'aperçu (visionneuses PDF, image, Office) ne se charge qu'à l'ouverture d'un panneau qui a une pièce.
const ApercuUniversel = dynamic(() => import("@/components/documents/apercu-universel").then((m) => m.ApercuUniversel), {
  ssr: false,
  loading: () => <div className="flex min-h-[190px] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Préparation de l&apos;aperçu…</div>,
});

type Geste = null | "modifier" | "contre" | "joindre" | "demander";

/**
 * LE PANNEAU D'UNE ÉCRITURE — l'aperçu de sa pièce, sa chaîne (qui a demandé, autorisé au centre, payé, quand), le budget
 * imputé, et quatre gestes : Modifier (`updateTransaction`), Contre-passer (motif obligatoire), Joindre un justificatif,
 * Demander la pièce. Une écriture contre-passée, ou qui en contre-passe une autre, ne propose plus de geste.
 */
export function PanneauEcriture({ e, droits, comptes, onFermer }: {
  e: DetailEcriture; droits: DroitsCompta; comptes: { id: string; nom: string }[]; onFermer: () => void;
}) {
  const [geste, setGeste] = React.useState<Geste>(null);
  const [grand, setGrand] = React.useState(false);
  const [vue, setVue] = React.useState(0);
  const piece = e.pieces[vue] ?? null;
  const estDep = e.direction === "OUT";
  const statut = e.contrePassee ? "Contre-passée" : e.prevue ? "Prévue" : "Validée";
  const gestesPossibles = droits.modifier && !e.compensationTexte;
  const basculer = (g: Geste) => setGeste((x) => (x === g ? null : g));

  return (
    <>
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <p className="text-[13px] text-muted-foreground">
            {estDep ? "Dépense" : "Recette"} · {e.reference} · <span className={cn("font-semibold", e.contrePassee ? "text-muted-foreground" : e.prevue ? "text-warning" : "text-success")}>{statut}</span>
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{e.tiersLabel}</p>
          <h2 className="text-[19px] font-bold [overflow-wrap:anywhere]">{e.tiers}</h2>
        </div>
        <button type="button" onClick={onFermer} aria-label="Fermer le détail" className="inline-flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg border border-border">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div>
        <p className={cn("text-[26px] font-bold tabular-nums", e.contrePassee ? "text-muted-foreground line-through" : estDep ? "" : "text-success")}>{formatCurrency(e.montant)}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{e.objet} · {dateLongue(e.date)}</p>
        {e.origineHref && !origineSansDossier(e.origine) ? (
          <Link href={e.origineHref} className="mt-1.5 inline-block rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs font-semibold text-primary">{e.origine} ↗</Link>
        ) : (
          <span className="mt-1.5 inline-block rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs font-semibold text-muted-foreground">{e.origine}</span>
        )}
      </div>

      {e.compensationTexte && <div className="rounded-[10px] bg-secondary px-3 py-2.5 text-[13px] text-muted-foreground">{e.compensationTexte}</div>}

      {/* LE JUSTIFICATIF — l'aperçu de la pièce elle-même, ou son absence en rouge. */}
      {piece ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-success">✓ {piece.nom}</h3>
            <div className="flex flex-none gap-1.5">
              <button type="button" onClick={() => setGrand((g) => !g)} className="h-[30px] rounded-md border border-border px-2.5 text-xs font-semibold">{grand ? "Réduire" : "Agrandir"}</button>
              <a href={piece.href.includes("?") ? piece.href : `${piece.href}?dl=1`} className="inline-flex h-[30px] items-center rounded-md border border-border px-2.5 text-xs font-semibold">Télécharger</a>
            </div>
          </div>
          <div className={cn("overflow-auto rounded-[10px] border border-border bg-muted/30 p-2", grand ? "max-h-[70dvh] min-h-[420px]" : "max-h-[260px] min-h-[190px]")}>
            <ApercuUniversel key={piece.id} src={piece.href} name={piece.nom} mime={piece.mime} telechargement={piece.href.includes("?") ? piece.href : `${piece.href}?dl=1`} />
          </div>
          {e.pieces.length > 1 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Autres pièces">
              {e.pieces.map((p, i) => (
                <li key={p.id}>
                  <button type="button" onClick={() => setVue(i)} aria-current={i === vue ? "true" : undefined} className={cn("max-w-[220px] truncate rounded-full border px-2.5 py-0.5 text-xs", i === vue ? "border-primary bg-primary/10 text-primary" : "border-border")}>
                    {p.nom}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <ManqueDePiece e={e} droits={droits} />
      )}

      <div className="flex flex-col gap-2">
        <TitreBloc>Chaîne</TitreBloc>
        {e.chaine.map((c, i) => (
          <div key={i} className="flex gap-2 text-[13px]">
            <span className={cn("inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-bold", c.attention ? "bg-warning/15 text-warning" : "bg-success/15 text-success")}>{c.attention ? "!" : "✓"}</span>
            <span className="min-w-0 flex-1"><span className="text-muted-foreground">{c.etape}</span> <strong>{c.qui}</strong></span>
            <span className="whitespace-nowrap text-muted-foreground">{c.date ? dateCourte(c.date) : "—"}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 rounded-[10px] bg-muted/50 p-3">
        <div className="flex justify-between gap-2 text-[13px]"><span className="text-muted-foreground">Budget imputé</span><strong className="text-right">{e.budget}</strong></div>
        {([
          ["Référence", e.reference], ["Catégorie", e.categorie], ["Compte", e.compte.long], ["Moyen", e.moyen],
          ...(e.invoiceRef ? [["Réf. facture", e.invoiceRef]] : []),
        ] as [string, string][]).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-t border-border pt-[7px] text-[13px]"><span className="text-muted-foreground">{k}</span><span className="text-right font-semibold [overflow-wrap:anywhere]">{v}</span></div>
        ))}
      </div>

      {gestesPossibles && (
        <div className="grid grid-cols-2 gap-1.5">
          {([
            ["modifier", "Modifier", false],
            ...(e.contrePassee || e.prevue ? [] : [["contre", "Contre-passer", true]]),
            ["joindre", e.pieces.length ? "Joindre une autre pièce" : "Joindre un justificatif", false],
            ...(e.destinataires.length ? [["demander", "Demander la pièce", false]] : []),
          ] as [Exclude<Geste, null>, string, boolean][]).map(([k, libelle, rouge]) => (
            <button
              key={k} type="button" onClick={() => basculer(k)} aria-expanded={geste === k}
              className={cn("h-[38px] rounded-lg border px-2.5 text-[13px] font-semibold",
                geste === k ? "border-primary bg-primary/10 text-primary" : rouge ? "border-destructive/40 text-destructive" : "border-border")}
            >
              {libelle}
            </button>
          ))}
        </div>
      )}

      {geste === "modifier" && <Modifier e={e} comptes={comptes} peutSupprimer={droits.supprimer} onFin={() => setGeste(null)} />}
      {geste === "contre" && <ContrePasser e={e} onFin={() => setGeste(null)} />}
      {geste === "joindre" && <Joindre e={e} onFin={() => setGeste(null)} />}
      {geste === "demander" && <Demander e={e} onFin={() => setGeste(null)} />}
    </>
  );
}

function ManqueDePiece({ e, droits }: { e: DetailEcriture; droits: DroitsCompta }) {
  const relance = useAction();
  const dest = e.destinataires[0];
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-destructive/40 bg-destructive/5 p-3">
      <span className="text-sm font-bold text-destructive">✕ Aucun justificatif</span>
      <span className="text-[13px] text-destructive">Attendu : {e.direction === "OUT" ? "une facture, une proforma, un état de paie, un bordereau ou une quittance" : "une facture de vente, un avis de crédit ou un bon de versement"}</span>
      {e.demandePiece && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] font-semibold text-warning">
          <span>Demandée à {e.demandePiece.a} le {dateCourte(e.demandePiece.le)}{e.demandePiece.fois > 1 ? ` · relancée ${e.demandePiece.fois - 1} fois` : ""}</span>
          {droits.modifier && dest && (
            <button
              type="button" disabled={relance.busy}
              onClick={() => relance.run(() => { const fd = new FormData(); fd.set("id", e.id); fd.set("destinataireId", dest.id); return demanderPieceEcriture(fd); }, undefined, { succes: `Relance envoyée à ${dest.nom.split(" · ")[0]}.` })}
              className="h-[30px] rounded-md border border-border bg-card px-2.5 text-xs font-semibold text-foreground"
            >
              Relancer
            </button>
          )}
        </div>
      )}
      <Retour ton="erreur">{relance.err}</Retour>
    </div>
  );
}

function Cadre({ titre, rouge = false, children }: { titre: string; rouge?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-2.5 rounded-[10px] border p-3.5", rouge ? "border-destructive/40" : "border-border")}>
      <h3 className={cn("text-[15px] font-bold", rouge && "text-destructive")}>{titre}</h3>
      {children}
    </div>
  );
}

function Modifier({ e, comptes, peutSupprimer, onFin }: { e: DetailEcriture; comptes: { id: string; nom: string }[]; peutSupprimer: boolean; onFin: () => void }) {
  const [objet, setObjet] = React.useState(e.objet);
  const [categorie, setCategorie] = React.useState(e.categorieCode);
  const [compte, setCompte] = React.useState(e.compteId ?? "");
  const enreg = useAction();
  const suppr = useAction();
  const cats = CATEGORIES_SAISIE[e.direction];
  const enregistrer = () => enreg.run(() => {
    // `updateTransaction` réécrit chaque champ : on lui renvoie l'écriture TELLE QU'ELLE EST, et seuls l'objet, la
    // catégorie et le compte changent. Le montant est figé (contre-passer puis ressaisir).
    const fd = new FormData();
    const c = comptes.find((x) => x.id === compte);
    for (const [k, v] of Object.entries({
      // La date n'est pas renvoyée : absente, elle reste telle quelle (un aller-retour par le jour UTC la décalerait).
      id: e.id, direction: e.direction, category: categorie, label: objet.trim(), amount: String(Math.abs(e.montant)),
      method: e.methodCode, account: c?.nom ?? e.compte.long, counterparty: e.tiers === "—" ? "" : e.tiers, invoiceRef: e.invoiceRef,
      status: e.statut, notes: e.notes, treasuryAccountId: compte,
    })) fd.set(k, v);
    return updateTransaction(fd);
  }, onFin, { succes: `${e.reference} modifiée. La version précédente reste dans l'historique.` });
  return (
    <Cadre titre="Modifier l'écriture">
      <Champ id="mod-objet" libelle="Objet"><input id="mod-objet" value={objet} onChange={(x) => setObjet(x.target.value)} className="h-[38px] rounded-lg border border-border bg-background px-2.5 text-sm" /></Champ>
      <Champ libelle="Catégorie"><Pastilles options={cats.map((c) => ({ valeur: c, libelle: FINANCE_CATEGORY[c] ?? c }))} valeur={categorie} onChoix={setCategorie} /></Champ>
      {comptes.length > 0 && <Champ libelle="Compte"><Pastilles options={comptes.map((c) => ({ valeur: c.id, libelle: c.nom }))} valeur={compte} onChoix={setCompte} /></Champ>}
      <p className="text-xs text-muted-foreground">Montant figé : pour le corriger, contre-passer puis ressaisir.</p>
      <Retour ton="erreur">{enreg.err ?? suppr.err}</Retour>
      <div className="flex flex-wrap justify-end gap-2">
        {peutSupprimer && (
          <BoutonDecisif
            type="button" variant="ghost" size="sm" className="mr-auto text-destructive" disabled={suppr.busy}
            confirmation={`Supprimer définitivement ${e.reference}`}
            onClick={() => suppr.run(() => { const fd = new FormData(); fd.set("id", e.id); return deleteTransaction(fd); }, onFin, { succes: "Écriture supprimée." })}
          >
            Supprimer
          </BoutonDecisif>
        )}
        <BoutonSecondaire onClick={onFin}>Annuler</BoutonSecondaire>
        <BoutonPrincipal onClick={enregistrer} disabled={enreg.busy || !objet.trim()}>Enregistrer</BoutonPrincipal>
      </div>
    </Cadre>
  );
}

function ContrePasser({ e, onFin }: { e: DetailEcriture; onFin: () => void }) {
  const [motif, setMotif] = React.useState("");
  const [precision, setPrecision] = React.useState("");
  const [manque, setManque] = React.useState(false);
  const act = useAction();
  const confirmer = () => {
    if (!motif && !precision.trim()) { setManque(true); return; }
    void act.run(() => { const fd = new FormData(); fd.set("id", e.id); fd.set("motif", motif); fd.set("precision", precision); return contrePasserEcriture(fd); }, onFin, { succes: `${e.reference} contre-passée.` });
  };
  return (
    <Cadre titre={`Contre-passer ${e.reference} ?`} rouge>
      <p className="text-[13px] text-muted-foreground">Une écriture inverse de <strong>{formatCurrency(-e.montant)}</strong> sera créée. L&apos;originale reste visible, barrée.</p>
      <Champ libelle="Motif"><Pastilles options={MOTIFS_CONTRE_PASSATION.map((m) => ({ valeur: m, libelle: m }))} valeur={motif} onChoix={(m) => { setMotif(m); setManque(false); }} /></Champ>
      <Champ id="cp-precision" libelle="Précision" facultatif>
        <input id="cp-precision" value={precision} onChange={(x) => setPrecision(x.target.value)} placeholder="ex. saisie manuelle + import du relevé" className="h-[38px] rounded-lg border border-border bg-background px-2.5 text-sm" />
      </Champ>
      {manque && <p className="text-[13px] font-semibold text-destructive">Choisissez un motif.</p>}
      <Retour ton="erreur">{act.err}</Retour>
      <div className="flex justify-end gap-2">
        <BoutonSecondaire onClick={onFin}>Annuler</BoutonSecondaire>
        <BoutonDecisif type="button" variant="destructive" size="md" disabled={act.busy} onClick={confirmer}>Confirmer la contre-passation</BoutonDecisif>
      </div>
    </Cadre>
  );
}

function Joindre({ e, onFin }: { e: DetailEcriture; onFin: () => void }) {
  const types = TYPES_PIECE[e.direction];
  const [type, setType] = React.useState(types[0]!.libelle);
  const [fichier, setFichier] = React.useState<File | null>(null);
  const [facture, setFacture] = React.useState<string | null>(null);
  const act = useAction();
  const entree = React.useRef<HTMLInputElement>(null);
  const valider = () => act.run(() => {
    const fd = new FormData();
    fd.set("id", e.id);
    if (facture) fd.set("factureId", facture);
    else if (fichier) { fd.set("fichier", fichier); fd.set("typePiece", type); }
    return joindreJustificatifEcriture(fd);
  }, onFin, { succes: `Pièce jointe à ${e.reference}.` });
  return (
    <Cadre titre="Joindre un justificatif">
      <Champ libelle="Type de pièce"><Pastilles options={types.map((t) => ({ valeur: t.libelle, libelle: t.libelle }))} valeur={type} onChoix={setType} /></Champ>
      <input ref={entree} type="file" accept=".pdf,image/*" className="sr-only" onChange={(x) => { setFichier(x.target.files?.[0] ?? null); setFacture(null); }} aria-label="Fichier du justificatif" />
      <button
        type="button" onClick={() => (fichier ? setFichier(null) : entree.current?.click())}
        className={cn("min-h-14 rounded-[10px] p-2.5 text-sm font-semibold", fichier ? "border border-success bg-success/10 text-success" : "border-2 border-dashed border-border bg-muted/40 text-primary")}
      >
        {fichier ? `✓ ${fichier.name} · retirer` : "Déposer ou choisir un fichier (PDF, photo)…"}
      </button>
      {e.direction === "OUT" && (
        <>
          <span className="text-[13px] font-semibold text-muted-foreground">Ou une pièce déjà dans l&apos;ERP · {e.tiers}</span>
          {e.facturesProposees.length === 0 && <p className="text-[13px] text-muted-foreground">Aucune facture libre de ce fournisseur au registre Legal.</p>}
          {e.facturesProposees.map((f) => (
            <button
              key={f.id} type="button" onClick={() => { setFacture((x) => (x === f.id ? null : f.id)); setFichier(null); }} aria-pressed={facture === f.id}
              className={cn("rounded-lg p-2.5 text-left text-[13px]", facture === f.id ? "border-2 border-primary bg-primary/10" : "border border-border")}
            >
              <span className="font-semibold">{f.titre} · {f.montant !== null ? formatCurrency(f.montant) : "—"}</span><br />
              <span className="text-xs text-muted-foreground">{f.maison}</span>
              {f.suggeree && <><br /><span className="text-xs font-semibold text-success">Même fournisseur, même montant</span></>}
            </button>
          ))}
        </>
      )}
      <Retour ton="erreur">{act.err}</Retour>
      <div className="flex justify-end gap-2">
        <BoutonSecondaire onClick={onFin}>Annuler</BoutonSecondaire>
        <BoutonPrincipal onClick={valider} disabled={act.busy || (!fichier && !facture)}>Joindre</BoutonPrincipal>
      </div>
    </Cadre>
  );
}

function Demander({ e, onFin }: { e: DetailEcriture; onFin: () => void }) {
  const [a, setA] = React.useState(e.destinataires[0]?.id ?? "");
  const prenom = (e.destinataires.find((d) => d.id === a)?.nom ?? "").split(" · ")[0];
  const [message, setMessage] = React.useState(
    `Bonjour ${prenom}, merci de déposer ${e.pieces.length ? "l'original de la pièce" : "le justificatif"} du paiement du ${dateCourte(e.date)} (${formatCurrency(Math.abs(e.montant))}).`,
  );
  const act = useAction();
  return (
    <Cadre titre="Demander la pièce">
      <Champ libelle="À"><Pastilles options={e.destinataires.map((d) => ({ valeur: d.id, libelle: d.nom }))} valeur={a} onChoix={setA} /></Champ>
      <Champ id="dem-message" libelle="Message"><input id="dem-message" value={message} onChange={(x) => setMessage(x.target.value)} className="h-[38px] rounded-lg border border-border bg-background px-2.5 text-sm" /></Champ>
      <Retour ton="erreur">{act.err}</Retour>
      <div className="flex justify-end gap-2">
        <BoutonSecondaire onClick={onFin}>Annuler</BoutonSecondaire>
        <BoutonPrincipal
          disabled={act.busy || !a}
          onClick={() => act.run(() => { const fd = new FormData(); fd.set("id", e.id); fd.set("destinataireId", a); fd.set("message", message); return demanderPieceEcriture(fd); }, onFin, { succes: `Demande envoyée à ${prenom}.` })}
        >
          Envoyer la demande
        </BoutonPrincipal>
      </div>
    </Cadre>
  );
}
