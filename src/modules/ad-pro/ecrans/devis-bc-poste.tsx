"use client";

import * as React from "react";
import { Loader2, FileText, FileDown, FileCheck, Wand2, Pencil, ScanText, CheckCircle2, AlertTriangle, Paperclip, Clock, Circle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { DevisDePosteVue } from "../infra/requetes/devis-poste";
import type { BcDePoste } from "../infra/pieces-poste";
import { lienFichierEmis } from "@/lib/legal/fichiers-emis";
import { refusMontantDesDevis } from "../domaine/devis-poste";
import { modifierBcDuPoste, previsualiserBcDuPoste } from "../actions-postes-paiement";
import { validerLignesDuDevis, enregistrerLignesDuDevis, lireLesLignesDuDevis, preparerBrouillonExcelPoste, deposerBcSignePoste } from "../actions-postes-lignes";
import { ReviserPieceButton } from "@/components/legal/reviser-piece";
import { ModifierNumeroBc } from "@/components/references/modifier-numero-bc";
import { ETIQUETTE_BROUILLON } from "@/lib/bons-de-commande/brouillon";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LIGNES D'UN DEVIS DE POSTE ET LE BON DE COMMANDE QU'ELLES FONT GÉNÉRER (§118.206).
 *
 * Deux morceaux de la carte d'un poste :
 *
 *   • `BlocBonDeCommande` — le contenu de la case « Bon de commande » : les BC du poste (un PAR DEVIS), et, pour chaque
 *     devis validé sans BC, son BROUILLON EXCEL (Direction, 11/2026 — né de la validation, numéro réservé, pas encore dans
 *     Legal) : on le télécharge, on le fait signer, on dépose la version signée, qui fait naître le BC signé au registre.
 *     « Préparer le brouillon » reste là quand un brouillon manque, inactif avec sa raison s'il ne peut pas aboutir — la
 *     même règle (`refusGenerationBC`, `refusMontantDesDevis`) que l'action (§118.83). « Joindre un BC existant » demande
 *     le BC à l'assistante. Une copie de la même pièce, ou une proposition écartée d'un voyageur, ne compte pas
 *     (`devisMisAPart`).
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
  // Le brouillon Excel (numéro réservé) : à signer et à déposer — ou à refaire si les lignes validées ont changé.
  if (d.brouillon?.excel && d.etat === "A_GENERER") {
    return { texte: d.brouillon.excelPerime ? "Brouillon à refaire" : `Brouillon ${d.brouillon.excel.numero} — à signer`, ton: "attente" };
  }
  // Un aperçu préparé mais pas encore validé : « Brouillon — à vérifier par le demandeur » (rien n'est numéroté ni envoyé).
  if (d.brouillon && (d.etat === "A_GENERER" || d.etat === "A_REGENERER")) return { texte: ETIQUETTE_BROUILLON, ton: "attente" };
  switch (d.etat) {
    case "A_GENERER": return { texte: "BC à générer", ton: "attente" };
    case "A_REGENERER": return { texte: `BC à régénérer (${d.nbAjoutees > 0 ? `+${d.nbAjoutees}` : ""}${d.nbAjoutees > 0 && d.nbRetirees > 0 ? " " : ""}${d.nbRetirees > 0 ? `−${d.nbRetirees}` : ""} ligne${d.nbAjoutees + d.nbRetirees > 1 ? "s" : ""})`, ton: "attente" };
    case "A_JOUR": return { texte: "BC à jour", ton: "ok" };
    case "FIGE": return { texte: "BC figé — voir ci-dessous", ton: "alerte" };
    case "A_ANNULER": return { texte: "plus aucune ligne validée", ton: "alerte" };
    case "MIS_A_PART": return { texte: "ne compte pas", ton: "ok" };
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
        {/* SIGNÉ, SEUL SON NUMÉRO SE MODIFIE ENCORE (Direction, 14/10/2026) : circuit et signature conservés. */}
        {peutModifier && bc.revision && (
          <ModifierNumeroBc
            legalDocumentId={bc.id} numero={bc.revision.numero} version={bc.revision.version} valeurs={bc.revision.valeurs} signe
            extra={{ id: itemId }} envoyer={modifierBcDuPoste}
          />
        )}
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

export function BlocBonDeCommande({ itemId, bcs, devis, accorde, refusGeneration, peutTraiter, peutJoindre, peutModifier, busy, run, onJoindre, onReviser, repli }: {
  itemId: string;
  bcs: BcDePoste[];
  devis: DevisDePosteVue[];
  accorde: number | null;
  /** Pourquoi le brouillon ne peut pas naître (`refusGenerationBC`) — `null` : il le peut. */
  refusGeneration: string | null;
  /** Préparer le brouillon et déposer la version signée : qui traite les devis du poste (le droit de les valider). */
  peutTraiter: boolean;
  peutJoindre: boolean;
  /** Le demandeur peut-il modifier le BC généré (« Modifier le BC », tant qu'il n'est pas signé) ? */
  peutModifier: boolean;
  busy: string | null;
  run: Run;
  onJoindre: () => void;
  /** « Demander une révision » du poste, quand la personne peut la demander — le geste qui lève un dépassement. */
  onReviser?: () => void;
  /** Ce que la case montrait avant (demande chez l'assistante, déposé, centre…) quand aucun BC n'est encore rattaché. */
  repli: React.ReactNode;
}) {
  const vivants = devis.filter((d) => !d.annule);
  // LE BROUILLON EXCEL NAÎT DE LA VALIDATION (Direction, 11/2026) : chaque devis à lignes validées sans BC a le sien — ou l'aura.
  const aSigner = vivants.filter((d) => d.etat === "A_GENERER");
  // LE PLAFOND SUR LES DEVIS QUI COMPTENT — une copie de la même pièce, une proposition écartée n'y entrent pas (§118.5 :
  // le même calcul que l'action, `refusMontantDuPoste`).
  const depasse = refusMontantDesDevis(vivants, accorde);
  const pourquoiPas = refusGeneration ?? depasse;
  const figes = vivants.filter((d) => (d.etat === "FIGE" || d.etat === "A_ANNULER") && d.refus);
  const preparer = () => {
    const fd = new FormData();
    fd.set("id", itemId);
    void run(`brw:${itemId}`, () => preparerBrouillonExcelPoste(fd), "Brouillon du bon de commande prêt.");
  };
  const enPreparation = busy === `brw:${itemId}`;

  return (
    <>
      {bcs.length === 0 && aSigner.length === 0 ? repli : bcs.map((bc) => {
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

      {aSigner.map((d) => (
        <BrouillonDuDevis key={d.pieceId} d={d} itemId={itemId} peutTraiter={peutTraiter} busy={busy} run={run} />
      ))}

      {vivants.some((d) => d.structure && d.bc && d.etat !== "A_JOUR") && (
        <ul className="space-y-0.5 border-t border-border/60 pt-1">
          {vivants.filter((d) => d.structure && d.bc && d.etat !== "A_JOUR").map((d) => {
            const e = phraseEtat(d);
            return (
              <li key={d.pieceId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere] sm:truncate" title={d.titre}>
                  <NomDuDevis d={d} /> — {d.nbValidees} ligne{d.nbValidees > 1 ? "s" : ""} validée{d.nbValidees > 1 ? "s" : ""}
                </span>
                {e && <span className={e.ton === "ok" ? "text-success" : e.ton === "alerte" ? "text-destructive" : "text-warning"}>{e.texte}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {figes.map((d) => <p key={d.pieceId} className="flex gap-1 text-destructive"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {d.refus}</p>)}
      {aSigner.some((d) => !d.brouillon?.excel || d.brouillon.excelPerime) && pourquoiPas && (
        <p className="flex gap-1 text-warning"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {pourquoiPas}</p>
      )}

      {(peutTraiter && aSigner.some((d) => !d.brouillon?.excel || d.brouillon.excelPerime)) || peutJoindre ? (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {/* LE GESTE EST TOUJOURS LÀ quand un brouillon manque : inactif, il porte sa raison (écrite au-dessus) — §118.83. */}
          {peutTraiter && aSigner.some((d) => !d.brouillon?.excel || d.brouillon.excelPerime) && (
            <Button size="sm" onClick={preparer} disabled={enPreparation || Boolean(pourquoiPas)} title={pourquoiPas ?? undefined}>
              {enPreparation ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              Préparer le brouillon
            </Button>
          )}
          {peutTraiter && depasse && onReviser && (
            <button type="button" onClick={onReviser} className="inline-flex min-h-9 items-center gap-1 text-primary hover:underline sm:min-h-0">
              Demander une révision du poste
            </button>
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

/**
 * LE BROUILLON EXCEL D'UN DEVIS, ET LE DÉPÔT DE SA VERSION SIGNÉE (Direction, 11/2026). Le fichier Excel se télécharge, s'imprime, se
 * complète ou se signe ; la version signée (scan ou photo) se dépose ici avec le nom du signataire. Luna y cherche la
 * signature et le numéro du brouillon ; accepté, le BC entre dans Legal déjà signé et la case Facture s'ouvre.
 */
function BrouillonDuDevis({ d, itemId, peutTraiter, busy, run }: {
  d: DevisDePosteVue; itemId: string; peutTraiter: boolean; busy: string | null; run: Run;
}) {
  const [ouvert, setOuvert] = React.useState(false);
  const excel = d.brouillon?.excel && !d.brouillon.excelPerime ? d.brouillon.excel : null;
  const cle = `sig:${d.pieceId}`;
  const total = d.entete.tvaRate === null ? `${dzd(d.totalValideHt)} · sans TVA` : `${dzd(d.totalValideTtc)} TTC`;
  const deposer = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("id", itemId);
    fd.set("pieceId", d.pieceId);
    void run(cle, async () => {
      const r = await deposerBcSignePoste(fd);
      if (r.ok) setOuvert(false);
      return r;
    }, "Bon de commande signé enregistré dans Legal.");
  };
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-dashed border-border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          {excel ? `BC ${excel.numero}` : "Bon de commande"}
          <span className="rounded-full border border-dashed border-border px-2 text-[0.6875rem] font-normal text-muted-foreground">Brouillon</span>
        </span>
        <span className="tabular-nums text-muted-foreground">{total} <span className="text-xs">· d&apos;après <NomDuDevis d={d} /></span></span>
      </div>
      {excel ? (
        <>
          <p className="text-muted-foreground">
            Pas encore dans Legal. Téléchargez le fichier Excel, complétez-le, imprimez-le ou faites-le signer, puis déposez la version signée : c&apos;est elle qui
            entre dans Legal, déjà signée.
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <a href={`/api/documents/${excel.documentId}?dl=1`} className="inline-flex min-h-9 items-center gap-1 text-primary hover:underline sm:min-h-0" aria-label={`Télécharger le brouillon Excel du BC ${excel.numero}`}>
              <FileDown className="h-3.5 w-3.5" /> Télécharger le fichier Excel
            </a>
            {peutTraiter && !ouvert && (
              <Button size="sm" onClick={() => setOuvert(true)}><FileCheck className="h-3.5 w-3.5" /> Déposer la version signée</Button>
            )}
          </div>
          {peutTraiter && ouvert && (
            <form onSubmit={deposer} className="space-y-2 rounded-md border border-border bg-background p-2.5">
              <label className="block space-y-0.5 text-xs" htmlFor={`copie-${d.pieceId}`}>
                Bon de commande signé (PDF ou photo de la page signée)
                <input id={`copie-${d.pieceId}`} name="copieSignee" type="file" required accept=".pdf,.png,.jpg,.jpeg,.webp" className="block w-full text-sm" />
              </label>
              <label className="block space-y-0.5 text-xs" htmlFor={`signataire-${d.pieceId}`}>
                Signé par
                <input id={`signataire-${d.pieceId}`} name="signataire" required maxLength={120} placeholder="Nom et qualité du signataire" className={champ} />
              </label>
              <p className="text-xs text-muted-foreground">Luna vérifie que la page porte une signature et le numéro {excel.numero} avant d&apos;enregistrer.</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" type="submit" disabled={busy === cle}>
                  {busy === cle ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileCheck className="h-3.5 w-3.5" />} Déposer la version finale
                </Button>
                <Button size="sm" type="button" variant="ghost" onClick={() => setOuvert(false)}>Annuler</Button>
              </div>
            </form>
          )}
        </>
      ) : (
        <p className="text-muted-foreground">
          {d.brouillon?.excel ? `Les lignes validées ont changé depuis le brouillon ${d.brouillon.excel.numero} : il se refait sous le même numéro.` : "Le brouillon Excel se prépare à la validation des lignes."}
        </p>
      )}
    </div>
  );
}

// ───────────────────────── Les lignes d'un devis ─────────────────────────

interface LigneSaisie { id: string; reference: string; unit: string; quantity: string; unitPrice: string }

const saisieDe = (l: DevisDePosteVue["lignes"][number]): LigneSaisie => ({
  id: l.id, reference: l.reference, unit: l.unit ?? "", quantity: l.quantity != null ? String(l.quantity) : "", unitPrice: l.unitPrice != null ? String(l.unitPrice) : "",
});

const champ = "w-full rounded border border-border bg-background px-1.5 py-2 text-xs outline-none focus:border-primary/60 sm:py-1";

/** Une ligne qui PEUT être validée pour ce poste : complète, sans réserve de lecture, libre ailleurs. */
const validable = (l: DevisDePosteVue["lignes"][number]): boolean =>
  !l.refusValidation && !l.valideeAilleurs && !l.aVerifier && l.quantity != null && l.unitPrice != null;

/**
 * LES CASES COCHÉES À L'OUVERTURE (Direction, 11/2026) : les lignes déjà validées ; et, tant que rien ne l'est ni qu'aucun BC ne
 * porte le devis, les lignes BIEN LUES — proposées, pas validées : la validation reste un geste (elle fait naître le brouillon).
 */
function cochesInitiales(devis: DevisDePosteVue): Set<string> {
  const validees = devis.lignes.filter((l) => l.validee);
  if (validees.length > 0 || devis.bc) return new Set(validees.map((l) => l.id));
  return new Set(devis.lignes.filter((l) => l.lue !== null && validable(l)).map((l) => l.id));
}

export function PanneauLignesDevis({ itemId, devis, peutEditer, busy, run, onClose }: {
  itemId: string;
  devis: DevisDePosteVue;
  peutEditer: boolean;
  busy: string | null;
  run: Run;
  onClose: () => void;
}) {
  const [coches, setCoches] = React.useState<Set<string>>(() => cochesInitiales(devis));
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
    setCoches(cochesInitiales(devis));
    setRows(devis.lignes.map(saisieDe));
    setCompare(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const gele = Boolean(devis.bc && (devis.bc.signe || devis.bc.facture));
  const porteUnBc = devis.bc !== null;
  const dejaValidees = new Set(devis.lignes.filter((l) => l.validee).map((l) => l.id));
  const changees = devis.lignes.some((l) => coches.has(l.id) !== dejaValidees.has(l.id));
  const nouvellesLues = devis.lignes.some((l) => coches.has(l.id) && !dejaValidees.has(l.id) && l.lue !== null);
  // « TOUT VALIDER » (Direction, 11/2026) : chaque ligne validable du devis, en un clic — un devis qui ne sert qu'à ce poste.
  const toutes = devis.lignes.filter((l) => validable(l) || dejaValidees.has(l.id)).map((l) => l.id);
  const toutDejaValide = toutes.every((lid) => dejaValidees.has(lid));
  const toutLues = devis.lignes.some((l) => toutes.includes(l.id) && !dejaValidees.has(l.id) && l.lue !== null);
  const occupe = busy !== null && busy.endsWith(`:${devis.pieceId}`);

  const fd = (extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.set("id", itemId);
    f.set("pieceId", devis.pieceId);
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };
  const valider = (ids: ReadonlySet<string> = coches) => {
    const f = fd();
    for (const l of devis.lignes) if (ids.has(l.id)) f.append("ligneId", l.id);
    if (compare) f.set("compare", "1");
    void run(`val:${devis.pieceId}`, () => validerLignesDuDevis(f), "Lignes validées.");
  };
  const toutValider = () => {
    const ids = new Set(toutes);
    setCoches(ids);
    valider(ids);
  };
  const enregistrer = () => {
    const f = fd({ tvaRate: tva, extraTaxLabel: taxeLibelle, extraTaxRate: taxeTaux, announcedTotal: totalImprime });
    for (const r of rows) {
      f.append("ligneId", r.id); f.append("ligneReference", r.reference); f.append("ligneUnite", r.unit);
      f.append("ligneQuantite", r.quantity); f.append("lignePrix", r.unitPrice);
    }
    // `run` garde déjà l'appel (levée, délai) : la promesse ne fait que refermer l'édition sur un succès.
    void run(`edit:${devis.pieceId}`, () => enregistrerLignesDuDevis(f).then((r) => {
      if (r.ok) setEdition(false);
      return r;
    }), "Lignes enregistrées.");
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
          {devis.lignes.some((l) => l.validee) ? "" : " Les lignes bien lues sont cochées : comparez-les au devis, puis validez — la validation prépare le brouillon du bon de commande."}
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
          {devis.entete.tvaRate === null ? (
            <p className="text-muted-foreground">
              Aucune TVA indiquée sur le devis : les montants sont ceux du papier, sans TVA ajoutée.
            </p>
          ) : (
            // LA TVA RETENUE SE VOIT (audit Ad & Pro, 14/10) : elle s'ajoutera au bon de commande. Jusqu'ici la carte ne
            // montrait que des montants HT — un taux mal lu ne se découvrait qu'à l'aperçu du BC, ou pas du tout.
            <p className="tabular-nums text-muted-foreground">
              TVA retenue : {devis.entete.tvaRate.toLocaleString("fr-FR")} % — validé : {dzd(devis.totalValideTtc)} TTC. Vérifiez qu&apos;elle est bien imprimée sur le devis.
            </p>
          )}
          {devis.ecartTotal && (
            <p className="flex gap-1 text-warning">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> Les lignes lues font {dzd(devis.ecartTotal.calcule)} HT, le devis imprime {dzd(devis.ecartTotal.annonce)} : une ligne manque peut-être, ou un chiffre est faux.
            </p>
          )}
          {gele && devis.refus && <p className="text-destructive">{devis.refus}</p>}
          {(nouvellesLues || toutLues) && !gele && (
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
            <Button size="sm" onClick={() => valider()} disabled={occupe || !changees || gele || (nouvellesLues && !compare)}>
              {busy === `val:${devis.pieceId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Valider les lignes cochées
            </Button>
          )}
          {!edition && devis.structure && !gele && !toutDejaValide && toutes.length > 0 && (
            <Button size="sm" variant={changees ? "outline" : "primary"} onClick={toutValider} disabled={occupe || (toutLues && !compare)}
              title={toutLues && !compare ? "Cochez d'abord « J'ai comparé ces lignes au devis »." : undefined}>
              <CheckCircle2 className="h-3.5 w-3.5" /> Tout valider ({toutes.length})
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
