"use client";

import * as React from "react";
import { Loader2, Eye, FileText, FileDown, FileCheck, Wand2, Pencil, ScanText, CheckCircle2, AlertTriangle, Paperclip, Clock, Circle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { DevisDePosteVue } from "@/lib/queries/ad-pro-devis-poste";
import type { BcDePoste } from "@/lib/ad-pro/pieces-poste";
import { lienFichierEmis } from "@/lib/legal/fichiers-emis";
import { refusDepassement } from "@/lib/ad-pro/devis-poste";
import {
  validerLignesDuDevis, enregistrerLignesDuDevis, lireLesLignesDuDevis, genererBonDeCommandePoste, modifierBcDuPoste, previsualiserBcDuPoste,
} from "@/lib/actions/ad-pro-item-actions";
import { ReviserPieceButton } from "@/components/legal/reviser-piece";
import { ETIQUETTE_BROUILLON } from "@/lib/bons-de-commande/brouillon";
import { ApercuBonDeCommande } from "@/components/ad-pro/apercu-bc-poste";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LIGNES D'UN DEVIS DE POSTE ET LE BON DE COMMANDE QU'ELLES FONT GÉNÉRER (§118.206).
 *
 * Deux morceaux de la carte d'un poste :
 *
 *   • `BlocBonDeCommande` — le contenu de la case « Bon de commande » : les BC du poste (un PAR DEVIS quand ils sont
 *     générés), chacun avec son Word et son PDF, et les deux gestes — « Générer » avec un petit CTA, ou « Joindre un
 *     BC existant » (la demande à l'assistante, qui l'uploade). Il ne propose QUE ce que l'action acceptera (§118.83) :
 *     la même règle (`refusGenerationBC`, `refusDepassement`) est lue ici et par l'action.
 *   • `PanneauLignesDevis` — les lignes d'UN devis : référence ou désignation, unité, quantité, prix unitaire, total ;
 *     une case « validée » par ligne (« S'il oublie une référence, il peut juste la cocher »), la correction à la main,
 *     et la relecture du fichier. Une ligne lue par Luna est une PROPOSITION : elle ne se valide que complète, et après
 *     l'attestation « j'ai comparé au devis ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, okText: string) => Promise<void>;

const dzd = (n: number): string => formatCurrency(n);

/** Les liens d'un BC généré : son Word et son PDF, sous la porte de la pièce — téléchargeables l'un et l'autre. */
function LiensBC({ bc }: { bc: BcDePoste }) {
  if (!bc.emis.docx && !bc.emis.pdf) return null;
  const lien = "inline-flex min-h-9 items-center gap-0.5 text-primary hover:underline sm:min-h-0";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      {bc.emis.docx && <a className={lien} href={lienFichierEmis(bc.id, "docx", true)} aria-label={`Télécharger le Word de ${bc.reference ?? bc.titre}`}><FileDown className="h-3 w-3" /> Word</a>}
      {bc.emis.pdf && <a className={lien} href={lienFichierEmis(bc.id, "pdf")} target="_blank" rel="noreferrer" aria-label={`Ouvrir le PDF de ${bc.reference ?? bc.titre}`}><FileText className="h-3 w-3" /> PDF</a>}
    </span>
  );
}

/**
 * LE NOM D'UN DEVIS, CLIQUABLE (Direction, 10/2026) : quand le fichier uploadé existe, la référence l'ouvre — la même route
 * (`/api/documents/<id>`) que les autres pièces du poste ; sans fichier, le nom reste du texte.
 */
function NomDuDevis({ d }: { d: Pick<DevisDePosteVue, "reference" | "titre" | "fichierId"> }) {
  const nom = d.reference ?? d.titre;
  return d.fichierId
    ? <a href={`/api/documents/${d.fichierId}`} target="_blank" rel="noreferrer" className="text-primary hover:underline" aria-label={`Ouvrir le fichier du devis ${nom}`}>{nom}</a>
    : <>{nom}</>;
}

function phraseEtat(d: DevisDePosteVue): { texte: string; ton: "ok" | "attente" | "alerte" } | null {
  // Un aperçu préparé mais pas encore validé : « Brouillon — à vérifier par le demandeur » (rien n'est numéroté ni envoyé).
  if (d.brouillon && (d.etat === "A_GENERER" || d.etat === "A_REGENERER")) return { texte: ETIQUETTE_BROUILLON, ton: "attente" };
  switch (d.etat) {
    case "A_GENERER": return { texte: "BC à générer", ton: "attente" };
    case "A_REGENERER": return { texte: `BC à régénérer (${d.nbAjoutees > 0 ? `+${d.nbAjoutees}` : ""}${d.nbAjoutees > 0 && d.nbRetirees > 0 ? " " : ""}${d.nbRetirees > 0 ? `−${d.nbRetirees}` : ""} ligne${d.nbAjoutees + d.nbRetirees > 1 ? "s" : ""})`, ton: "attente" };
    case "A_JOUR": return { texte: "BC à jour", ton: "ok" };
    case "FIGE": return { texte: "BC figé — voir ci-dessous", ton: "alerte" };
    case "A_ANNULER": return { texte: "plus aucune ligne validée", ton: "alerte" };
    default: return null;
  }
}

/**
 * LE BC SIGNÉ REMPLACE LE BC NON SIGNÉ (Direction, 06/10) : la copie que les Finances ont téléversée est LA pièce qu'on
 * ouvre, avec son signataire et ce que Luna a repéré. Avant la signature : le Word et le PDF générés, et « Modifier le
 * BC » — une nouvelle version à chaque fois, sans limite.
 */
function PieceDuBC({ bc, itemId, peutModifier }: { bc: BcDePoste; itemId: string; peutModifier: boolean }) {
  const lien = "inline-flex min-h-9 items-center gap-0.5 text-primary hover:underline sm:min-h-0";
  if (bc.copieSignee) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2">
        <a className={lien} href={`/api/documents/${bc.copieSignee.documentId}`} target="_blank" rel="noreferrer" aria-label={`Ouvrir le bon de commande signé ${bc.reference ?? bc.titre}`}>
          <FileCheck className="h-3 w-3" /> Voir le BC signé
        </a>
        {bc.copieSignee.constat && <InfoBulle label="Ce que Luna a vérifié" align="left">{bc.copieSignee.constat}</InfoBulle>}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3">
      <LiensBC bc={bc} />
      {peutModifier && bc.revision && bc.etape !== "SIGNE" && (
        <ReviserPieceButton
          discret libelle="Modifier le BC" motifFacultatif sansImpression
          legalDocumentId={bc.id} type="BON_DE_COMMANDE" numero={bc.revision.numero} version={bc.revision.version}
          valeurs={bc.revision.valeurs}
          envoyer={(fd) => { fd.set("id", itemId); return modifierBcDuPoste(fd); }}
          apercu={(fd) => { fd.set("id", itemId); fd.set("legalDocumentId", bc.id); return previsualiserBcDuPoste(fd); }}
        />
      )}
    </span>
  );
}

/**
 * LA FRISE D'UN BC — dates à l'appui (Direction, 07/10 : « je ne sais pas si le BC a été envoyé aux Finances ou pas »).
 * Une ligne par étape franchie ou en cours, et QUI a la main : l'écran répond à la question sans paragraphe.
 */
function FriseBC({ bc }: { bc: BcDePoste }) {
  const etape = bc.etape ?? "HORS_CIRCUIT";
  type Ton = "fait" | "en-cours" | "alerte" | "refus" | "a-venir";
  const lignes: { cle: string; ton: Ton; texte: string; aide?: string }[] = [
    { cle: "cree", ton: "fait", texte: `Créé le ${formatDate(bc.creeLe)}` },
  ];
  if (etape === "HORS_CIRCUIT") lignes.push({ cle: "hors", ton: "a-venir", texte: "Antérieur au circuit de signature" });
  if (etape === "SANS_PORTE") lignes.push({ cle: "centre", ton: "alerte", texte: "À adresser au centre de validation" });
  if (etape === "A_VALIDER") lignes.push({ cle: "centre", ton: "en-cours", texte: "En validation — centre Ad & Pro" });
  if (etape === "A_REVOIR") lignes.push({ cle: "centre", ton: "alerte", texte: "À revoir — demandé par le centre" });
  if (etape === "REFUSE") lignes.push({ cle: "centre", ton: "refus", texte: "Refusé par le centre" });
  if (etape === "A_SIGNER") {
    lignes.push({
      cle: "finances", ton: "en-cours", texte: "Chez les Finances — en attente de signature",
      aide: "Les Finances signent le BC et téléversent la copie signée depuis leur module « Bons de commande ». La facture se dépose ensuite.",
    });
  }
  if (etape === "A_CORRIGER") lignes.push({ cle: "finances", ton: "alerte", texte: "Renvoyé par les Finances — à corriger" });
  if (etape === "SIGNE") {
    lignes.push({ cle: "signe", ton: "fait", texte: `Signé${bc.signeLe ? ` le ${formatDate(bc.signeLe)}` : ""}${bc.copieSignee?.signataire ? ` par ${bc.copieSignee.signataire}` : ""}` });
  } else if (etape === "A_VALIDER" || etape === "A_REVOIR" || etape === "SANS_PORTE") {
    lignes.push({ cle: "signe", ton: "a-venir", texte: "Signature des Finances" });
  }
  const style: Record<Ton, { classe: string; icone: React.ReactNode }> = {
    "fait": { classe: "text-success", icone: <CheckCircle2 className="h-3.5 w-3.5" /> },
    "en-cours": { classe: "font-medium text-primary", icone: <Clock className="h-3.5 w-3.5" /> },
    "alerte": { classe: "font-medium text-warning", icone: <AlertTriangle className="h-3.5 w-3.5" /> },
    "refus": { classe: "font-medium text-destructive", icone: <XCircle className="h-3.5 w-3.5" /> },
    "a-venir": { classe: "text-muted-foreground", icone: <Circle className="h-3.5 w-3.5" /> },
  };
  return (
    <ol className="space-y-1" aria-label={`Étapes du bon de commande ${bc.reference ?? bc.titre}`}>
      {lignes.map((l) => (
        <li key={l.cle} className={`flex items-center gap-1.5 ${style[l.ton].classe}`}>
          {style[l.ton].icone}<span>{l.texte}</span>
          {l.aide && <InfoBulle label="Ce qui se passe à cette étape" align="left">{l.aide}</InfoBulle>}
        </li>
      ))}
    </ol>
  );
}

export function BlocBonDeCommande({ itemId, bcs, devis, accorde, refusGeneration, peutGenerer, peutValider, peutJoindre, peutModifier, busy, run, onJoindre, repli }: {
  itemId: string;
  bcs: BcDePoste[];
  devis: DevisDePosteVue[];
  accorde: number | null;
  /** Pourquoi la génération n'est pas ouverte (`refusGenerationBC`) — `null` : elle l'est. Seul le demandeur la voit. */
  refusGeneration: string | null;
  peutGenerer: boolean;
  /** Valider l'aperçu et l'envoyer aux Finances : le demandeur de la demande, ou le Super Admin (jamais qui n'a fait que préparer). */
  peutValider: boolean;
  peutJoindre: boolean;
  /** Le demandeur peut-il modifier le BC généré (« Modifier le BC », tant qu'il n'est pas signé) ? */
  peutModifier: boolean;
  busy: string | null;
  run: Run;
  onJoindre: () => void;
  /** Ce que la case montrait avant (demande chez l'assistante, déposé, centre…) quand aucun BC n'est encore rattaché. */
  repli: React.ReactNode;
}) {
  const vivants = devis.filter((d) => !d.annule);
  // GÉNÉRER = préparer l'APERÇU (un brouillon, sans numéro) ; le BC n'existe qu'une fois l'aperçu validé par le demandeur.
  const aFaireTous = vivants.filter((d) => d.etat === "A_GENERER" || d.etat === "A_REGENERER");
  const aFaire = aFaireTous.filter((d) => !d.brouillon);
  const avecApercu = aFaireTous.filter((d) => d.brouillon);
  const [apercuOuvert, setApercuOuvert] = React.useState<string | null>(null);
  const apercuDuDevis = apercuOuvert ? avecApercu.find((d) => d.pieceId === apercuOuvert) ?? null : null;
  const depasse = refusDepassement(
    vivants.reduce((s, d) => s + Math.round(d.totalValideTtc * 100), 0) / 100, accorde,
    vivants.reduce((s, d) => s + Math.round(d.totalValideHt * 100), 0) / 100,
    vivants.filter((d) => d.nbValidees > 0).every((d) => d.entete.tvaRate !== null),
  );
  const enCours = busy !== null && busy.startsWith("gen:") && busy.endsWith(`:${itemId}`);
  const generer = (pieceId: string | null) => {
    const fd = new FormData();
    fd.set("id", itemId);
    if (pieceId) fd.set("pieceId", pieceId);
    void run(`gen:${pieceId ?? "tous"}:${itemId}`, () => genererBonDeCommandePoste(fd), "Aperçu du bon de commande prêt — à vérifier par le demandeur.");
  };
  const ouverte = peutGenerer && refusGeneration === null && !depasse;
  const figes = vivants.filter((d) => (d.etat === "FIGE" || d.etat === "A_ANNULER") && d.refus);

  return (
    <>
      {bcs.length === 0 ? repli : bcs.map((bc) => {
        const source = vivants.find((d) => d.bc?.id === bc.id);
        return (
          <div key={bc.id} className="min-w-0 space-y-2 rounded-lg border border-border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="inline-flex min-w-0 items-center gap-1.5 font-medium" title={bc.titre}>
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" /> {bc.reference ?? bc.titre}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {bc.montant != null ? dzd(bc.montant) : "montant non saisi"}
                {source?.reference && <span className="text-xs"> · d&apos;après {source.reference}</span>}
              </span>
            </div>
            <FriseBC bc={bc} />
            <PieceDuBC bc={bc} itemId={itemId} peutModifier={peutModifier} />
          </div>
        );
      })}

      {vivants.some((d) => d.structure && (d.nbValidees > 0 || d.bc)) && (
        <ul className="space-y-0.5 border-t border-border/60 pt-1">
          {vivants.filter((d) => d.structure && (d.nbValidees > 0 || d.bc)).map((d) => {
            const e = phraseEtat(d);
            const actionnable = ouverte && (d.etat === "A_GENERER" || d.etat === "A_REGENERER") && !d.brouillon;
            return (
              <li key={d.pieceId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere] sm:truncate" title={d.titre}>
                  <NomDuDevis d={d} /> — {d.nbValidees} ligne{d.nbValidees > 1 ? "s" : ""} validée{d.nbValidees > 1 ? "s" : ""} · <span className="tabular-nums">{d.entete.tvaRate === null ? `${dzd(d.totalValideHt)} · sans TVA (aucune sur le devis)` : `${dzd(d.totalValideTtc)} TTC`}</span>
                </span>
                {e && !(actionnable && aFaire.length === 1) && <span className={e.ton === "ok" ? "text-success" : e.ton === "alerte" ? "text-destructive" : "text-warning"}>{e.texte}</span>}
                {actionnable && aFaire.length > 1 && (
                  <button type="button" onClick={() => generer(d.pieceId)} disabled={enCours} className="min-h-9 text-primary hover:underline disabled:opacity-50 sm:min-h-0">
                    {d.etat === "A_REGENERER" ? "Régénérer" : "Générer"}
                  </button>
                )}
                {d.brouillon && (peutGenerer || peutValider) && (
                  <button type="button" onClick={() => setApercuOuvert(d.pieceId)} className="inline-flex min-h-9 items-center gap-1 font-medium text-primary hover:underline sm:min-h-0">
                    <Eye className="h-3 w-3" /> Voir l&apos;aperçu{peutValider ? " et valider" : ""}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {figes.map((d) => <p key={d.pieceId} className="flex gap-1 text-destructive"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {d.refus}</p>)}
      {depasse && aFaire.length > 0 && <p className="flex gap-1 text-warning"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {depasse}</p>}
      {peutGenerer && aFaire.length > 0 && refusGeneration && <p className="text-muted-foreground">{refusGeneration}</p>}

      {apercuDuDevis && (
        <ApercuBonDeCommande
          itemId={itemId} devis={apercuDuDevis} peutEditer={peutGenerer} peutValider={peutValider} busy={busy} run={run}
          onClose={() => setApercuOuvert(null)}
        />
      )}

      {(ouverte && aFaire.length > 0) || peutJoindre ? (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {ouverte && aFaire.length === 1 && (
            <Button size="sm" onClick={() => generer(aFaire[0].pieceId)} disabled={enCours}>
              {enCours ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              {aFaire[0].etat === "A_REGENERER" ? "Régénérer le BC (aperçu)" : "Générer le BC (aperçu)"}
            </Button>
          )}
          {ouverte && aFaire.length > 1 && (
            <Button size="sm" onClick={() => generer(null)} disabled={enCours}>
              {enCours ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              Générer tous les BC ({aFaire.length}) — aperçus
            </Button>
          )}
          {peutJoindre && (
            <button type="button" onClick={onJoindre} className="inline-flex min-h-9 items-center gap-1 text-primary hover:underline sm:min-h-0">
              <Paperclip className="h-3 w-3" /> Joindre un BC existant
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}

// ───────────────────────── Les lignes d'un devis ─────────────────────────

interface LigneSaisie { id: string; reference: string; unit: string; quantity: string; unitPrice: string }

const saisieDe = (l: DevisDePosteVue["lignes"][number]): LigneSaisie => ({
  id: l.id, reference: l.reference, unit: l.unit ?? "", quantity: l.quantity != null ? String(l.quantity) : "", unitPrice: l.unitPrice != null ? String(l.unitPrice) : "",
});

const champ = "w-full rounded border border-border bg-background px-1.5 py-2 text-xs outline-none focus:border-primary/60 sm:py-1";

export function PanneauLignesDevis({ itemId, devis, peutEditer, busy, run, onClose }: {
  itemId: string;
  devis: DevisDePosteVue;
  peutEditer: boolean;
  busy: string | null;
  run: Run;
  onClose: () => void;
}) {
  const [coches, setCoches] = React.useState<Set<string>>(() => new Set(devis.lignes.filter((l) => l.validee).map((l) => l.id)));
  const [compare, setCompare] = React.useState(false);
  const [edition, setEdition] = React.useState(false);
  const [rows, setRows] = React.useState<LigneSaisie[]>(() => devis.lignes.map(saisieDe));
  const [tva, setTva] = React.useState(devis.entete.tvaRate !== null ? String(devis.entete.tvaRate) : "");
  const [taxeLibelle, setTaxeLibelle] = React.useState(devis.entete.extraTaxLabel ?? "");
  const [taxeTaux, setTaxeTaux] = React.useState(devis.entete.extraTaxRate != null ? String(devis.entete.extraTaxRate) : "");
  const [totalImprime, setTotalImprime] = React.useState(devis.entete.announcedTotal != null ? String(devis.entete.announcedTotal) : "");

  // L'état se recale sur le devis rechargé : une validation faite ailleurs ne reste pas affichée comme cochée ici.
  const signature = devis.lignes.map((l) => `${l.id}:${l.validee ? 1 : 0}:${l.quantity}:${l.unitPrice}`).join("|");
  React.useEffect(() => {
    setCoches(new Set(devis.lignes.filter((l) => l.validee).map((l) => l.id)));
    setRows(devis.lignes.map(saisieDe));
    setCompare(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const gele = Boolean(devis.bc && (devis.bc.signe || devis.bc.facture));
  const porteUnBc = devis.bc !== null;
  const dejaValidees = new Set(devis.lignes.filter((l) => l.validee).map((l) => l.id));
  const changees = devis.lignes.some((l) => coches.has(l.id) !== dejaValidees.has(l.id));
  const nouvellesLues = devis.lignes.some((l) => coches.has(l.id) && !dejaValidees.has(l.id) && l.lue !== null);
  const occupe = busy !== null && busy.endsWith(`:${devis.pieceId}`);

  const fd = (extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.set("id", itemId);
    f.set("pieceId", devis.pieceId);
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };
  const valider = () => {
    const f = fd();
    for (const l of devis.lignes) if (coches.has(l.id)) f.append("ligneId", l.id);
    if (compare) f.set("compare", "1");
    void run(`val:${devis.pieceId}`, () => validerLignesDuDevis(f), "Lignes validées.");
  };
  const enregistrer = () => {
    const f = fd({ tvaRate: tva, extraTaxLabel: taxeLibelle, extraTaxRate: taxeTaux, announcedTotal: totalImprime });
    for (const r of rows) {
      f.append("ligneId", r.id); f.append("ligneReference", r.reference); f.append("ligneUnite", r.unit);
      f.append("ligneQuantite", r.quantity); f.append("lignePrix", r.unitPrice);
    }
    void run(`edit:${devis.pieceId}`, async () => {
      const r = await enregistrerLignesDuDevis(f);
      if (r.ok) setEdition(false);
      return r;
    }, "Lignes enregistrées.");
  };
  const relire = () => void run(`lire:${devis.pieceId}`, () => lireLesLignesDuDevis(fd()), "Devis relu.");

  const modifier = (i: number, k: keyof LigneSaisie, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const ajouter = () => setRows((rs) => [...rs, { id: "", reference: "", unit: "", quantity: "", unitPrice: "" }]);

  const totalCoche = devis.lignes
    .filter((l) => coches.has(l.id) && l.totalHt != null)
    .reduce((s, l) => s + Math.round((l.totalHt as number) * 100), 0) / 100;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-2.5 text-xs" aria-label={`Lignes du devis ${devis.reference ?? devis.titre}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 font-medium text-foreground [overflow-wrap:anywhere]">Lignes du devis <NomDuDevis d={devis} />{devis.fournisseur ? ` — ${devis.fournisseur}` : ""}</p>
        <button type="button" onClick={onClose} className="min-h-9 px-2 text-muted-foreground hover:text-foreground sm:min-h-0 sm:px-0">Fermer</button>
      </div>
      {devis.entete.lectureNote && (
        <p className="text-muted-foreground">
          Lignes lues par la plateforme — {devis.entete.lectureNote}
          {devis.lignes.every((l) => l.validee) ? " Toutes validées automatiquement." : " Certaines sont à vérifier : comparez-les au devis avant de les valider."}
        </p>
      )}

      {!devis.structure && !edition && (
        <p className="text-muted-foreground">Ce devis n&apos;a pas encore de lignes. Faites-le lire, ou saisissez-les depuis le papier.</p>
      )}

      {devis.structure && !edition && (
        // Au téléphone, chaque ligne du devis devient une carte (classe `mobile-cards` de globals.css) :
        // six colonnes ne tiennent pas en 360 px, et la case « Valider » doit rester sous le pouce.
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[34rem]">
            <thead className="text-[0.6875rem] text-muted-foreground">
              <tr><th className="w-8 py-1">Valider</th><th>Référence / désignation</th><th>Unité</th><th className="text-right">Qté</th><th className="text-right">PU HT</th><th className="text-right">Total HT</th></tr>
            </thead>
            <tbody>
              {devis.lignes.map((l) => {
                const empeche = Boolean(l.refusValidation || l.valideeAilleurs || gele);
                return (
                  <tr key={l.id} className="border-t border-border/50 align-top">
                    <td className="py-1" data-label="Valider">
                      <input
                        type="checkbox" checked={coches.has(l.id)} disabled={empeche && !coches.has(l.id) ? true : gele}
                        title={l.valideeAilleurs ? `Déjà validée pour « ${l.valideeAilleurs} »` : l.refusValidation ?? undefined}
                        aria-label={`Valider la ligne ${l.reference}`}
                        className="max-sm:h-5 max-sm:w-5"
                        onChange={(e) => setCoches((cur) => { const n = new Set(cur); if (e.target.checked) n.add(l.id); else n.delete(l.id); return n; })}
                      />
                    </td>
                    <td className="py-1 pr-2" data-sans-etiquette>
                      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        <span className="font-medium text-foreground">{l.reference}</span>
                        {l.aVerifier && <span className="block text-warning">{l.aVerifier}</span>}
                        {l.valideeAilleurs && <span className="block text-muted-foreground">Validée pour « {l.valideeAilleurs} »</span>}
                        {l.refusValidation && !l.valideeAilleurs && <span className="block text-warning">{l.refusValidation}</span>}
                        {l.bcReference && <span className="block text-muted-foreground">Sur le BC {l.bcReference}</span>}
                      </div>
                    </td>
                    <td className="py-1" data-label="Unité"><span>{l.unit ?? "—"}</span></td>
                    <td className="py-1 text-right tabular-nums" data-label="Qté"><span>{l.quantity ?? "?"}</span></td>
                    <td className="py-1 text-right tabular-nums" data-label="PU HT"><span>{l.unitPrice != null ? dzd(l.unitPrice) : "?"}</span></td>
                    <td className="py-1 text-right tabular-nums" data-label="Total HT"><span>{l.totalHt != null ? dzd(l.totalHt) : "?"}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {edition && (
        <div className="space-y-1.5">
          <div className="overflow-x-auto">
            {/* Au téléphone : une carte par ligne, l'intitulé AU-DESSUS de son champ (pleine largeur). */}
            <table className="w-full text-left min-w-[34rem]">
              <thead className="text-[0.6875rem] text-muted-foreground"><tr><th>Référence / désignation</th><th className="w-20">Unité</th><th className="w-20">Qté</th><th className="w-24">PU HT</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.id}-${i}`} className="align-top">
                    <td className="pr-1" data-label="Référence / désignation"><input className={champ} value={r.reference} onChange={(e) => modifier(i, "reference", e.target.value)} aria-label={`Référence de la ligne ${i + 1}`} /></td>
                    <td className="pr-1" data-label="Unité"><input className={champ} value={r.unit} onChange={(e) => modifier(i, "unit", e.target.value)} aria-label={`Unité de la ligne ${i + 1}`} /></td>
                    <td className="pr-1" data-label="Qté"><input className={champ} inputMode="decimal" value={r.quantity} onChange={(e) => modifier(i, "quantity", e.target.value)} aria-label={`Quantité de la ligne ${i + 1}`} /></td>
                    <td className="" data-label="PU HT"><input className={champ} inputMode="decimal" value={r.unitPrice} onChange={(e) => modifier(i, "unitPrice", e.target.value)} aria-label={`Prix unitaire HT de la ligne ${i + 1}`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={ajouter} className="inline-flex min-h-10 w-full items-center justify-center rounded-md border border-dashed border-primary/40 px-3 font-medium text-primary hover:underline sm:min-h-0 sm:w-auto sm:justify-start sm:border-0 sm:px-0 sm:font-normal">+ Ajouter une ligne</button>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className="space-y-0.5">TVA imprimée (%)<input className={champ} inputMode="decimal" value={tva} onChange={(e) => setTva(e.target.value)} placeholder="non indiquée" /></label>
            <label className="space-y-0.5">Taxe supplémentaire<input className={champ} value={taxeLibelle} onChange={(e) => setTaxeLibelle(e.target.value)} placeholder="Taxe Pub" /></label>
            <label className="space-y-0.5">Taux de la taxe (%)<input className={champ} inputMode="decimal" value={taxeTaux} onChange={(e) => setTaxeTaux(e.target.value)} /></label>
            <label className="space-y-0.5">Total HT imprimé<input className={champ} inputMode="decimal" value={totalImprime} onChange={(e) => setTotalImprime(e.target.value)} /></label>
          </div>
          <p className="text-muted-foreground">Une quantité ou un prix laissé vide reste à compléter : la ligne ne se valide pas. Une ligne dont le contenu change n&apos;est plus validée.</p>
        </div>
      )}

      {devis.structure && !edition && (
        <div className="space-y-1">
          <p className="tabular-nums text-foreground">
            Total du devis lu : {dzd(devis.totalDevisHt)} HT
            {devis.entete.announcedTotal != null && <> · imprimé : {dzd(devis.entete.announcedTotal)}</>}
            {" · "}validé : {dzd(totalCoche)} HT
          </p>
          {devis.entete.tvaRate === null && (
            <p className="text-muted-foreground">
              Aucune TVA indiquée sur le devis : les montants sont ceux du papier, sans TVA ajoutée.
            </p>
          )}
          {devis.ecartTotal && (
            <p className="flex gap-1 text-warning">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> Les lignes lues font {dzd(devis.ecartTotal.calcule)} HT, le devis imprime {dzd(devis.ecartTotal.annonce)} : une ligne manque peut-être, ou un chiffre est faux.
            </p>
          )}
          {gele && devis.refus && <p className="text-destructive">{devis.refus}</p>}
          {nouvellesLues && (
            <label className="flex items-start gap-1.5 py-1 sm:py-0">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="mt-0.5 shrink-0 max-sm:h-5 max-sm:w-5" />
              <span>J&apos;ai comparé ces lignes au devis (elles viennent de la lecture du fichier).</span>
            </label>
          )}
        </div>
      )}

      {peutEditer && (
        <div className="flex flex-wrap items-center gap-2">
          {/* UN SEUL BOUTON PRINCIPAL À LA FOIS (Direction, 06/10) : « Valider » n'existe que s'il reste quelque
              chose à valider — un devis bien lu est déjà validé d'office, et la carte ne propose alors que
              « Générer le BC ». */}
          {!edition && devis.structure && changees && (
            <Button size="sm" onClick={valider} disabled={occupe || !changees || gele || (nouvellesLues && !compare)}>
              {busy === `val:${devis.pieceId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Valider les lignes cochées
            </Button>
          )}
          {edition ? (
            <>
              <Button size="sm" onClick={enregistrer} disabled={occupe}>{busy === `edit:${devis.pieceId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />} Enregistrer les lignes</Button>
              <Button size="sm" variant="ghost" onClick={() => { setEdition(false); setRows(devis.lignes.map(saisieDe)); }}>Annuler</Button>
            </>
          ) : (
            <>
              <button type="button" disabled={porteUnBc} title={porteUnBc ? "Un bon de commande porte déjà ce devis : annulez-le d'abord." : undefined} onClick={() => setEdition(true)} className="inline-flex min-h-9 items-center gap-1 text-primary sm:min-h-0 hover:underline disabled:text-muted-foreground disabled:no-underline">
                <Pencil className="h-3 w-3" /> {devis.structure ? "Corriger les lignes" : "Saisir les lignes"}
              </button>
              {!porteUnBc && !devis.lignes.some((l) => l.validee || l.valideeAilleurs) && (
                <button type="button" onClick={relire} disabled={occupe} className="inline-flex min-h-9 items-center gap-1 text-primary sm:min-h-0 hover:underline disabled:opacity-50">
                  {busy === `lire:${devis.pieceId}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <ScanText className="h-3 w-3" />} {devis.structure ? "Relire le devis" : "Lire le devis"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
