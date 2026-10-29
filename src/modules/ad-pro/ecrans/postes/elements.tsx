"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, CheckCircle2, ExternalLink, Send, FileText, ThumbsUp, Pencil, Circle, X, Wallet, Split, Paperclip, ShieldCheck, FileCheck2, Clock } from "lucide-react";
import type { AdProItemKind, AdProItemStatus, AdProItemOrderStage } from "@prisma/client";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/utils";
import { LIBELLE_BC_SOUS_LE_SEUIL, LIBELLE_ORDRE_EMIS } from "../../domaine/postes";
import { LIBELLE_ETAPE_BC } from "@/lib/bons-de-commande/regle";
import type { CleGeste, EtatEtape } from "../../domaine/poste-etapes";
import { NATURE_MATERIEL_STOCK } from "@/lib/promo/reservations";
import type { PieceDePoste } from "../../infra/pieces-poste";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import type { ItemRow } from "../items-panel";

// Les éléments de la carte d'un poste : cases de pièces, état du BC, icônes et frise de la chaîne d'achat,
// et les quelques constantes que le panneau, la carte et les formulaires partagent.

/** Un poste « Matériel du stock » n'engage pas d'argent : il ne montre ni montant, ni budget, ni BC. */
export const estPosteStock = (it: { kind: AdProItemKind }) => it.kind === NATURE_MATERIEL_STOCK;

/** Un poste qui liste les articles du stock se compose tant qu'il n'est ni soumis ni accordé. */
export const POSTE_STOCK_EDITABLE: readonly AdProItemStatus[] = ["DRAFT", "REVISION", "REJECTED"];

/**
 * La rangée de boutons au pied d'un petit formulaire : empilée et pleine largeur au téléphone (le pouce
 * vise une barre, pas un mot), en ligne au-delà. Un `BoutonDecisif` y prend `max-sm:w-full` : son
 * enveloppe s'étire seule, pas le bouton qu'elle contient.
 */
export const RANGEE_ACTIONS = "flex flex-col gap-2 sm:flex-row sm:flex-wrap";

/** L'état « l'écran se met à jour » — tous les gestes de toutes les cartes attendent. */
export const RAFRAICHISSEMENT = "rafraichissement";

/** Une case de la chaîne d'achat — son titre, son contenu, et un « Ajouter » discret quand il y a lieu. */
export function CasePiece({ titre, ajouter, libelleAjouter = "Ajouter", children }: { titre: string; ajouter?: () => void; libelleAjouter?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5 rounded-lg bg-secondary/30 px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 font-medium text-foreground">{titre}</p>
        {/* Au téléphone, une vraie cible (40 px, bordée) : c'est ici qu'on dépose devis et factures. */}
        {ajouter && (
          <button
            type="button" onClick={ajouter}
            className="inline-flex h-10 shrink-0 items-center gap-1 rounded-lg border border-primary/40 bg-card px-3 text-sm font-medium text-primary hover:underline sm:h-auto sm:gap-0.5 sm:border-0 sm:bg-transparent sm:px-0 sm:text-xs sm:font-normal"
          >
            <Plus className="h-4 w-4 sm:h-3 sm:w-3" /> {libelleAjouter}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * LA DEMANDE DE DEVIS DU POSTE (Direction, 07/10) — la lettre la plus récente, en PDF et Word, cliquable ; chaque fichier se
 * supprime. Les générations précédentes ne s'affichent pas : la dernière fait foi.
 */
export function LettresDevis({ lettres, supprimer }: { lettres: { id: string; nom: string; pdf: boolean; le: string }[]; supprimer?: (id: string) => void }) {
  if (lettres.length === 0) return <p className="text-muted-foreground">Pas encore générée.</p>;
  const derniere = lettres[0].le.slice(0, 16);
  const recentes = lettres.filter((l) => l.le.slice(0, 16) === derniere);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">Générée le {formatDate(lettres[0].le)}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {recentes.map((l) => (
          <li key={l.id} className="inline-flex items-center gap-1">
            <a href={`/api/documents/${l.id}`} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1 font-medium text-primary hover:underline sm:min-h-0">
              <FileText className="h-3.5 w-3.5" /> {l.pdf ? "PDF" : "Word"}
            </a>
            {supprimer && (
              <BoutonDecisif brut type="button" onClick={() => supprimer(l.id)} aria-label={`Supprimer ${l.nom}`} className="rounded p-1.5 text-muted-foreground hover:text-destructive sm:p-0.5">
                <X className="h-3.5 w-3.5" />
              </BoutonDecisif>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Une pièce du registre — titre court, montant, fichiers ; le titre mène à sa fiche Legal. */
export function LignePiece({ piece, retirer }: { piece: PieceDePoste; retirer?: () => void }) {
  return (
    <div className={`flex min-w-0 items-start gap-1.5 ${piece.annulee ? "opacity-60" : ""}`}>
      <FileText className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        {/* Le FICHIER, pas la fiche Legal : qui voit la demande lit les pièces de ses postes (exception de
            lecture, §118.204), mais la fiche `/legal/[id]` peut lui rester fermée — un lien vers une page
            refusée est un geste offert puis retiré (§118.83). */}
        {piece.fichierId ? (
          <a href={`/api/documents/${piece.fichierId}`} target="_blank" rel="noreferrer" className={`block truncate font-medium text-primary hover:underline ${piece.annulee ? "line-through" : ""}`} title={piece.titre}>
            {piece.reference ?? piece.titre}
          </a>
        ) : (
          <span className={`block truncate font-medium ${piece.annulee ? "line-through" : ""}`} title={piece.titre}>{piece.reference ?? piece.titre}</span>
        )}
        <p className="text-muted-foreground">
          {piece.montant != null ? <span className="tabular-nums">{formatCurrency(piece.montant)}</span> : "montant non saisi"}
          {piece.fichiers > 0 && <> · <Paperclip className="inline h-3 w-3" /> {piece.fichiers}</>}
          {piece.annulee && " · annulée"}
        </p>
        {piece.aussiPour.length > 0 && <p className="truncate text-muted-foreground" title={piece.aussiPour.join(", ")}>Couvre aussi : {piece.aussiPour.join(", ")}</p>}
        {/* TOUS LES FICHIERS DE LA PIÈCE (Direction, 07/10) — le titre ouvre le premier ; les autres se listent ici. */}
        {piece.fichiersListe.length > 1 && (
          <ul className="mt-0.5 space-y-0.5">
            {piece.fichiersListe.map((f) => (
              <li key={f.id} className="min-w-0">
                <a href={`/api/documents/${f.id}`} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-xs text-primary hover:underline" title={f.nom}>
                  <Paperclip className="h-3 w-3 shrink-0" /> <span className="truncate">{f.nom}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      {retirer && (
        <BoutonDecisif brut type="button" onClick={retirer} aria-label={`Retirer ${piece.titre} du poste`} className="-m-1.5 rounded p-2 text-muted-foreground hover:text-destructive sm:m-0 sm:p-0.5">
          <X className="h-4 w-4 sm:h-3 sm:w-3" />
        </BoutonDecisif>
      )}
    </div>
  );
}

/** Où en est le bon de commande du poste — chez l'assistante, déposé, au centre, à signer, signé. */
export function EtatBC({ item }: { item: ItemRow }) {
  const bc = item.pieces.bc;
  const note = (
    <>
      {item.orderNote && <p className="line-clamp-2 text-muted-foreground" title={item.orderNote}>Demande : {item.orderNote}</p>}
      {item.orderDecisionNote && (
        <p className="line-clamp-2 text-muted-foreground" title={item.orderDecisionNote}>
          {item.orderSansCentre ? LIBELLE_BC_SOUS_LE_SEUIL : "Centre"} : {item.orderDecisionNote}
        </p>
      )}
    </>
  );
  if (bc) {
    const etape = bc.etape ?? "HORS_CIRCUIT";
    return (
      <>
        <LignePiece piece={bc} />
        <p className={etape === "SIGNE" ? "text-success" : etape === "REFUSE" ? "text-destructive" : "text-muted-foreground"}>{LIBELLE_ETAPE_BC[etape]}</p>
      </>
    );
  }
  if (item.demandeBC?.etat === "DEPOSE") {
    return (
      <>
        <p className="font-medium text-foreground">Déposé — à vérifier</p>
        <Link href={`/pieces/${item.demandeBC.id}`} className="inline-flex items-center gap-1 text-primary hover:underline">Ouvrir le BC déposé <ExternalLink className="h-3 w-3" /></Link>
        {note}
      </>
    );
  }
  if (item.demandeBC?.etat === "CHEZ_ASSISTANTE") {
    return <><p className="text-muted-foreground">Chez {item.demandeBC.assistante ?? "l'assistante de direction"}</p>{note}</>;
  }
  const phrase: Partial<Record<AdProItemOrderStage, string>> = {
    REQUESTED: "Au centre de validation Ad & Pro",
    DIRECTION_OK: "Validé — à établir par l'assistante",
    REFUSED: "Refusé par le centre — à redemander",
    ISSUED: LIBELLE_ORDRE_EMIS,
  };
  return <><p className="text-muted-foreground">{phrase[item.orderStage] ?? (item.status === "APPROVED" ? "À demander" : "Après l'accord.")}</p>{note}</>;
}

export function IconeGeste({ cle }: { cle: CleGeste }) {
  switch (cle) {
    case "REPARTIR": return <Split className="h-4 w-4" />;
    case "CHIFFRER": return <Pencil className="h-4 w-4" />;
    case "VALIDER_OPS": case "DECIDER": case "VISER_BC": return <ThumbsUp className="h-4 w-4" />;
    case "GENERER_BC": return <FileText className="h-4 w-4" />;
    case "MONTANT": case "BUDGET": return <Wallet className="h-4 w-4" />;
    case "VERIFIER_BC": return <ShieldCheck className="h-4 w-4" />;
    case "DEMANDER_PAIEMENT": return <FileCheck2 className="h-4 w-4" />;
    default: return <Send className="h-4 w-4" />;
  }
}

/** Une étiquette sur la ligne du poste (« Rallonge », « Ajouté après décision ») — un mot, pas une phrase. */
export const ETIQUETTE = "rounded-md bg-warning/10 px-1.5 py-0.5 text-[0.6875rem] font-medium text-warning";

/** Le rendu d'un état d'étape — le même partout sur la carte : fait, en cours, à venir, refusé. */
export const STYLE_ETAPE: Record<EtatEtape, { texte: string; barre: string; icone: React.ReactNode; dit: string }> = {
  FAIT: { texte: "text-success", barre: "border-success", icone: <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />, dit: "fait" },
  EN_COURS: { texte: "font-medium text-primary", barre: "border-primary", icone: <Clock className="h-3.5 w-3.5 shrink-0" />, dit: "en cours" },
  A_VENIR: { texte: "text-muted-foreground", barre: "border-border", icone: <Circle className="h-3.5 w-3.5 shrink-0" />, dit: "à venir" },
  REFUSE: { texte: "font-medium text-destructive", barre: "border-destructive", icone: <X className="h-3.5 w-3.5 shrink-0" />, dit: "refusé" },
};

export interface OngletChaine { cle: string; libelle: string; court?: string; etat: EtatEtape; contenu: React.ReactNode }

/**
 * LA CHAÎNE DU POSTE — Accord → Devis → Bon de commande → Facture → Paiement, en une barre ; dessous, UNE étape à la fois.
 * Elle s'ouvre sur l'étape en cours (ou refusée), à défaut sur la dernière faite : quatre colonnes serrées obligeaient
 * à tout lire pour trouver la seule qui comptait.
 */
export function ChaineDuPoste({ onglets }: { onglets: OngletChaine[] }) {
  const parDefaut = (onglets.find((o) => o.etat === "EN_COURS" || o.etat === "REFUSE")
    ?? [...onglets].reverse().find((o) => o.etat === "FAIT")
    ?? onglets[0]).cle;
  const [choisi, setChoisi] = React.useState<string | null>(null);
  const actif = onglets.find((o) => o.cle === choisi) ?? onglets.find((o) => o.cle === parDefaut) ?? onglets[0];
  return (
    <div className="space-y-2 border-t border-border/70 pt-2.5">
      <div role="tablist" aria-label="Étapes du poste" className="grid gap-1" style={{ gridTemplateColumns: `repeat(${onglets.length}, minmax(0, 1fr))` }}>
        {onglets.map((o) => {
          const s = STYLE_ETAPE[o.etat];
          const selectionne = o.cle === actif.cle;
          return (
            <button
              key={o.cle} type="button" role="tab" aria-selected={selectionne} aria-label={`${o.libelle} : ${s.dit}`}
              onClick={() => setChoisi(o.cle)}
              className={cn(
                "flex min-h-10 min-w-0 items-center gap-1 rounded-b-md border-t-[3px] px-1.5 py-1.5 text-left text-xs transition-colors",
                s.barre, s.texte, selectionne ? "bg-secondary/70" : "hover:bg-secondary/40",
              )}
            >
              {s.icone}
              <span className="truncate">
                <span className="sm:hidden">{o.court ?? o.libelle}</span>
                <span className="hidden sm:inline">{o.libelle}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={actif.libelle}>{actif.contenu}</div>
    </div>
  );
}
