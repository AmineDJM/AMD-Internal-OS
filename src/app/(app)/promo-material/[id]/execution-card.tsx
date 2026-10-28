"use client";

import * as React from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Circle, Clock, FileText, Loader2, PackageCheck, Pencil, Send, Stethoscope, Trash2, Undo2, Upload, Wand2, X, XCircle } from "lucide-react";
import {
  genererBonsDeCommandePromo, modifierBonDeCommandePromo, annulerBonDeCommandePromo, marquerBonDeCommandeEnvoye,
  deposerFacturePromo, lireFacturePromo, demanderPaiementFacturePromo, adresserInfoMedicaleFacturePromo,
  receptionnerLigneFacturePromo, annulerReceptionLigneFacturePromo, annulerFacturePromo,
} from "@/lib/actions/promo-execution-actions";
import { formatDzd } from "@/lib/promo-material/devis";
import { designationAvecAction, type PromoAction } from "@/lib/promo-material/actions-fournisseur";
import { ETAT_RECEPTION_LABEL, totauxFacture, type EtatReception, type FamillePromo } from "@/lib/promo-material/achats";
import { familleAValidite, familleQuantifiee } from "@/lib/promo/catalogue";
import {
  formaliteDuDossier, gesteDeLaCommande, jourMois, pastillesDeLaCommande, totalDesCommandes, type CommandeFaits, type Pastille,
} from "@/lib/promo-material/fiche";
import { lienFichierEmis } from "@/lib/legal/fichiers-emis";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Textarea } from "@/components/ui/input";
import type { ActionResult } from "@/lib/actions/types";
import type { OptionCatalogue } from "@/lib/queries/promo-achats";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useSaisir } from "@/components/ui/dialogue";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { InfoBulle } from "@/components/ui/info-bulle";
import { ChampNumeroPiece } from "@/components/references/champ-numero-piece";
import { phraseNumeroSeul } from "@/lib/bons-de-commande/numero-seul";
import { ApercuBcPromo, type BrouillonAffiche } from "./apercu-bc-promo";
import { MenuLigne, useGeste, type EntreeMenu } from "./menu-ligne";

/**
 * L'EXÉCUTION D'UN DOSSIER DU CIRCUIT 2 — du devis retenu au stock (§118.152, §118.165).
 *
 * Une ligne par devis dont une ligne est retenue, et sur chaque ligne la chaîne ENTIÈRE, dans
 * l'ordre où elle se fait : le bon de commande (généré par la plateforme, validé par un centre
 * au-dessus du seuil, signé par les Finances, envoyé), ses factures DÉTAILLÉES (pré-remplies depuis
 * le BC, écarts mis en évidence, fichier obligatoire), la RÉCEPTION cochée ligne à ligne par le
 * demandeur (ce qui entre au stock), le paiement (après réception — ou malgré une ligne non livrée,
 * avec un renoncement confirmé), et la demande de visa — ou de déclaration au ministère — qui part
 * avec chaque paiement. Un geste n'apparaît que lorsqu'il est possible : un bouton qu'une action
 * refuse fait chercher la panne au lieu de dire ce qu'on attend.
 *
 * Les règles vivent dans les actions et le module pur (`promo-material/achats.ts`) ; l'écran calcule
 * ses totaux par la MÊME arithmétique, et ne fait que montrer ce que les règles permettent.
 */

export type NatureAffichee =
  | { type: "PRESTATION" }
  | { type: "STOCK"; famille: FamillePromo; libelle: string }
  | { type: "A_CHOISIR"; obligatoire: boolean };

export interface LigneFactureAffichee {
  id: string;
  designation: string;
  action: PromoAction | null;
  unite: string | null;
  quantite: number;
  prixUnitaire: number;
  quantiteRecue: number | null;
  /** Le jour où la réception a été cochée (ISO). */
  recueLe: string | null;
  renonce: boolean;
  etat: EtatReception;
  nature: NatureAffichee;
  /** Où la ligne est entrée : « Lot 3 — Fiche posologique — Nivolex ». */
  entree: string | null;
}

export interface FactureAffichee {
  id: string;
  reference: string | null;
  montant: number | null;
  date: string | null;
  etatReglement: string;
  /** L'état du règlement en code (`EtatReglement`) — ce que lit la pastille « Paiement ». */
  etat: string;
  reglee: boolean;
  paiementDemande: boolean;
  demandeInfoMedicale: { reference: string; nature: string; formalite?: string | null } | null;
  /** Le fichier déposé (table `Document`) — ouvert par `/api/documents/<id>`. */
  fichierId: string | null;
  /** Le détail ligne à ligne — nul pour une facture d'avant (§118.165). */
  detail: {
    tvaRate: number; extraTaxLabel: string | null; extraTaxRate: number | null; totalImprime: number | null;
    lignes: LigneFactureAffichee[];
  } | null;
}

export interface LigneBCAffichee {
  quoteLineId: string;
  designation: string;
  action: PromoAction | null;
  unite: string | null;
  quantite: number;
  prixUnitaire: number;
  reste: number;
}

export interface ExecutionAffichee {
  quoteId: string;
  fournisseur: string;
  reference: string | null;
  lignes: number;
  ttc: number;
  /** Ce qui est commandé, en mots courts (« Lingettes unitaires · 2 000 ») — sous le fournisseur. */
  articles: string[];
  bc: { id: string; reference: string | null; montant: number | null; etape: string; libelleEtape: string; pdf: boolean; docx: boolean } | null;
  envoyeLe: string | null;
  factures: FactureAffichee[];
  /** Les lignes du BC et ce qui reste à facturer — ce que la facture pré-remplit. */
  lignesBC: LigneBCAffichee[];
  /** Les taxes du devis (donc du BC) — reprises par la facture, corrigeables. */
  taxes: { tvaRate: number | null; extraTaxLabel: string | null; extraTaxRate: number | null };
  /** L'aperçu du BC « à vérifier par le demandeur » (sans numéro) — `null` : pas d'aperçu. */
  brouillon: BrouillonAffiche | null;
}

interface Props {
  id: string;
  executions: ExecutionAffichee[];
  /** Le demandeur, l'assistante de direction, la Direction — tranché au serveur. */
  canPilot: boolean;
  /** Le demandeur (le Super Admin en suppléance) coche la réception — tranché au serveur. */
  canReceive: boolean;
  /** Le dossier est en exécution (toutes les validations obtenues). */
  ouvert: boolean;
  /** Le catalogue et les produits, pour une ligne « en plus » qui choisit son article à la réception. */
  optionsReception: { catalogue: OptionCatalogue[]; produits: { id: string; nom: string }[] } | null;
  /** Valider l'aperçu d'un BC et l'envoyer aux Finances : le demandeur, ou le Super Admin — tranché au serveur. */
  peutValiderBc: boolean;
}

function useRun() {
  // LE RAFRAÎCHISSEMENT SUIVI (§118.172) : les gestes restent fermés jusqu'à l'arrivée des nouvelles données.
  const { enCours, rafraichir } = useRafraichir();
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const run = async (fn: () => Promise<ActionResult>, after?: () => void) => {
    setSaving(true); setErr(null); setMsg(null);
    let r: ActionResult;
    try {
      r = await fn();
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return;
    } finally {
      setSaving(false);
    }
    if (r.ok) { setMsg(r.message ?? null); after?.(); rafraichir(); } else setErr(r.error ?? "Le geste n'a pas abouti.");
  };
  return { saving: saving || enCours, err, msg, run };
}

const Erreur = ({ msg }: { msg: string | null }) =>
  msg ? <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{msg}</span></div> : null;
const Info = ({ msg }: { msg: string | null }) =>
  msg ? <div className="flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> <span>{msg}</span></div> : null;

const lien = "inline-flex min-h-9 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs hover:bg-secondary sm:min-h-0";
/** Un bouton au libellé long passe à la ligne au lieu de sortir de l'écran (le bouton est `nowrap` par défaut). */
const aLaLigne = "h-auto min-h-9 whitespace-normal py-1.5 sm:h-auto sm:min-h-8";
const nombre = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 3 });
const lire = (s: string): number => (s.trim() === "" ? 0 : Number(s.replace(/\s/g, "").replace(",", ".")));
const TON_ETAT: Record<EtatReception, "neutral" | "success" | "warning" | "danger"> = {
  EN_ATTENTE: "warning", RECUE: "success", PARTIELLE: "warning", NON_LIVREE: "danger", RELIQUAT_RENONCE: "neutral",
};

/** Choix de la formalité qui accompagne un paiement — visa publicitaire ou déclaration au ministère. */
function ChoixFormalite({ name, defaut }: { name: string; defaut?: string | null }) {
  return (
    <select name={name} required defaultValue={defaut ?? ""} className="h-10 w-full rounded-md border border-input bg-background px-2 text-base sm:h-9 sm:w-auto sm:text-sm" aria-label="Formalité à l'information médicale">
      <option value="" disabled>Formalité…</option>
      <option value="AD_VISA">Demande de visa publicitaire</option>
      <option value="MIP">Déclaration au ministère</option>
    </select>
  );
}

// ───────────────────────── Le dépôt d'une facture détaillée ─────────────────────────

function DepotFacture({ id, e, onDone, onCancel }: { id: string; e: ExecutionAffichee; onDone: () => void; onCancel: () => void }) {
  const { saving, err, run } = useRun();
  const aFacturer = e.lignesBC.filter((l) => l.reste > 0);
  const [saisies, setSaisies] = React.useState(() => aFacturer.map((l) => ({ quoteLineId: l.quoteLineId, quantite: String(l.reste), prix: String(l.prixUnitaire), lue: null as number | null, verifiee: false })));
  // LA LECTURE PAR LUNA (lot D2-F) : elle PROPOSE ; chaque ligne reportée se coche « vérifiée » après
  // comparaison au papier, et le dépôt refuse tant que ce n'est pas fait.
  const fichierRef = React.useRef<HTMLInputElement>(null);
  const [lecture, setLecture] = React.useState<Awaited<ReturnType<typeof lireFacturePromo>>["lecture"] | null>(null);
  const [lectureMsg, setLectureMsg] = React.useState<string | null>(null);
  const [lit, setLit] = React.useState(false);
  const [reference, setReference] = React.useState("");
  const [montant, setMontant] = React.useState("");
  const lireAvecLuna = async () => {
    const f = fichierRef.current?.files?.[0];
    if (!f) { setLectureMsg("Choisissez d'abord le fichier de la facture."); return; }
    setLit(true); setLectureMsg(null);
    const fd = new FormData(); fd.set("promoMaterialId", id); fd.set("quoteId", e.quoteId); fd.set("file", f);
    const r = await lireFacturePromo(fd).catch(() => ({ ok: false as const, error: "La lecture n'a pas abouti — saisissez depuis le papier." }));
    setLit(false);
    if (!r.ok || !r.lecture) { setLectureMsg(r.ok ? "Aucune lecture rendue." : (r.error ?? "La lecture n'a pas abouti.")); return; }
    const lu = r.lecture;
    setLecture(lu); setLectureMsg(r.message ?? null);
    if (lu.prerempli.reference) setReference(lu.prerempli.reference);
    if (lu.prerempli.totalImprime != null) setMontant(String(lu.prerempli.totalImprime));
    setSaisies((ss) => ss.map((s) => {
      const l = lu.prerempli.lignes.find((x) => x.quoteLineId === s.quoteLineId);
      return l ? { ...s, quantite: l.quantite != null ? String(l.quantite) : s.quantite, prix: l.prixUnitaire != null ? String(l.prixUnitaire) : s.prix, lue: l.rang, verifiee: false }
        : { ...s, quantite: "0", lue: null, verifiee: false };
    }));
  };
  const [tva, setTva] = React.useState(e.taxes.tvaRate !== null ? String(e.taxes.tvaRate) : "");
  const [taxe, setTaxe] = React.useState(e.taxes.extraTaxRate != null ? String(e.taxes.extraTaxRate) : "");
  const maj = (i: number, k: "quantite" | "prix" | "verifiee", v: string | boolean) => setSaisies((ss) => ss.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const totaux = totauxFacture(
    { tvaRate: lire(tva) || 0, extraTaxRate: taxe.trim() ? lire(taxe) : null },
    saisies.map((s) => ({ quantite: lire(s.quantite) || 0, prixUnitaire: lire(s.prix) || 0 })).filter((s) => s.quantite > 0),
  );

  if (aFacturer.length === 0) {
    return (
      <div className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
        Tout ce bon de commande est déjà facturé. <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Fermer</Button>
      </div>
    );
  }
  return (
    <form
      className="space-y-3 rounded-lg border border-border p-3"
      action={(f: FormData) => { f.set("promoMaterialId", id); f.set("quoteId", e.quoteId); run(() => deposerFacturePromo(f), onDone); }}
    >
      <p className="flex items-center gap-1 text-sm font-medium">
        Déposer une facture
        <InfoBulle label="Comment remplir la facture" align="left">
          Les lignes du bon de commande sont pré-remplies avec ce qui reste à facturer : corrigez la quantité et le prix pour coller à la
          facture (une ligne absente : mettez 0). Les écarts avec le BC sont signalés ; on ne facture pas plus que commandé.
        </InfoBulle>
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div><Label htmlFor={`fa-ref-${e.quoteId}`}>N° de facture *</Label><Input id={`fa-ref-${e.quoteId}`} name="reference" required value={reference} onChange={(ev) => setReference(ev.target.value)} /></div>
        <div><Label htmlFor={`fa-date-${e.quoteId}`}>Date</Label><Input id={`fa-date-${e.quoteId}`} name="invoiceDate" type="date" /></div>
        <div><Label htmlFor={`fa-file-${e.quoteId}`}>Fichier de la facture *</Label><Input ref={fichierRef} id={`fa-file-${e.quoteId}`} name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.doc,.docx" onChange={() => { setLecture(null); setSaisies((ss) => ss.map((x) => ({ ...x, lue: null, verifiee: false }))); }} /></div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button type="button" size="sm" variant="outline" onClick={lireAvecLuna} disabled={lit || saving}>{lit ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Lire avec Luna</Button>
        <span className="text-muted-foreground">Luna lit la facture et préremplit les lignes du BC ; vous vérifiez chacune contre le papier.</span>
      </div>
      {lectureMsg && <p className="text-xs">{lectureMsg}</p>}
      {lecture && (
        <div className="space-y-1 rounded-md border border-border bg-muted/40 p-2 text-xs">
          <input type="hidden" name="lectureId" value={lecture.lectureId} />
          <p className="text-muted-foreground">{lecture.noteMethode}</p>
          {lecture.prerempli.desaccordTotal && <p className="text-amber-700 dark:text-amber-400">{lecture.prerempli.desaccordTotal}</p>}
          {lecture.prerempli.lignes.filter((l) => !l.quoteLineId).map((l) => <p key={l.rang} className="text-amber-700 dark:text-amber-400">{l.phrase ?? `« ${l.designation} » : non reportée.`}</p>)}
          <label className="flex items-center gap-2"><input type="checkbox" name="totalVerifie" value="on" /> Total vérifié contre le papier</label>
        </div>
      )}
      {/* Au téléphone, chaque ligne du BC devient une carte (classe `mobile-cards`, intitulés en `data-label`) :
          saisir quantité et prix dans un tableau qui glisse de côté se fait mal au pouce. */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[620px]">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Ligne du BC</th>
              <th className="py-1 pr-2 text-right font-medium">Reste au BC</th>
              <th className="py-1 pr-2 font-medium">Quantité facturée</th>
              <th className="py-1 pr-2 font-medium">Prix unitaire HT</th>
              <th className="py-1 text-right font-medium">Total HT</th>
            </tr>
          </thead>
          <tbody>
            {aFacturer.map((l, i) => {
              const s = saisies[i];
              const q = lire(s.quantite); const p = lire(s.prix);
              const ecartQ = Number.isFinite(q) && Math.abs(q - l.reste) > 0.0005;
              const ecartP = Number.isFinite(p) && Math.abs(p - l.prixUnitaire) > 0.005;
              const trop = Number.isFinite(q) && q > l.reste + 0.0005;
              return (
                <tr key={l.quoteLineId} className="border-t border-border align-top">
                  <td className="py-1 pr-2 font-medium sm:font-normal">
                    <input type="hidden" name="ligneQuoteLineId" value={l.quoteLineId} />
                    <input type="hidden" name="ligneDesignation" value={l.designation} />
                    <input type="hidden" name="ligneLue" value={s.lue ?? ""} />
                    <input type="hidden" name="ligneVerifiee" value={s.verifiee ? "1" : "0"} />
                    <div className="w-full">
                      {designationAvecAction(l.designation, l.action)}
                      {s.lue !== null && (
                        <label className="mt-1 flex min-h-9 items-center gap-2 text-xs font-normal text-muted-foreground sm:min-h-0 sm:gap-1">
                          <input type="checkbox" className="h-4 w-4 sm:h-auto sm:w-auto" checked={s.verifiee} onChange={(ev) => maj(i, "verifiee", ev.target.checked)} /> lue par Luna — vérifiée
                        </label>
                      )}
                    </div>
                  </td>
                  <td data-label="Reste au BC" className="py-1 pr-2 text-right tabular-nums text-muted-foreground">{nombre(l.reste)}{l.unite ? ` ${l.unite}` : ""}</td>
                  <td data-label="Qté facturée" className="py-1 pr-2">
                    <div className="min-w-0 flex-1">
                      <Input name="ligneQuantite" value={s.quantite} onChange={(ev) => maj(i, "quantite", ev.target.value)} inputMode="decimal" aria-label={`Quantité facturée — ${l.designation}`}
                        className={`w-full sm:w-28 ${trop ? "border-destructive" : ecartQ ? "border-amber-500" : ""}`} />
                      {trop && <span className="block text-xs text-destructive">plus que le reste au BC</span>}
                      {!trop && ecartQ && <span className="block text-xs text-amber-700 dark:text-amber-400">≠ reste au BC</span>}
                    </div>
                  </td>
                  <td data-label="PU HT" className="py-1 pr-2">
                    <div className="min-w-0 flex-1">
                      <Input name="lignePrix" value={s.prix} onChange={(ev) => maj(i, "prix", ev.target.value)} inputMode="decimal" aria-label={`Prix unitaire — ${l.designation}`}
                        className={`w-full sm:w-32 ${ecartP ? "border-amber-500" : ""}`} />
                      {ecartP && <span className="block text-xs text-amber-700 dark:text-amber-400">BC : {formatDzd(l.prixUnitaire)}</span>}
                    </div>
                  </td>
                  <td data-label="Total HT" className="py-1 text-right tabular-nums">{Number.isFinite(q * p) ? formatDzd(Math.round(q * p * 100) / 100) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <div><Label htmlFor={`fa-tva-${e.quoteId}`}>TVA (%)</Label><Input id={`fa-tva-${e.quoteId}`} name="tvaRate" value={tva} onChange={(ev) => setTva(ev.target.value)} inputMode="decimal" /></div>
        <div><Label htmlFor={`fa-taxe-${e.quoteId}`}>{e.taxes.extraTaxLabel ?? "Taxe additionnelle"} (%)</Label><Input id={`fa-taxe-${e.quoteId}`} name="extraTaxRate" value={taxe} onChange={(ev) => setTaxe(ev.target.value)} inputMode="decimal" placeholder="vide = aucune" /></div>
        {e.taxes.extraTaxLabel && <input type="hidden" name="extraTaxLabel" value={e.taxes.extraTaxLabel} />}
        <div className="sm:col-span-2">
          <Label htmlFor={`fa-mt-${e.quoteId}`}>Total TTC imprimé sur la facture *</Label>
          <Input id={`fa-mt-${e.quoteId}`} name="amount" inputMode="decimal" required placeholder={formatDzd(totaux.ttc)} value={montant} onChange={(ev) => setMontant(ev.target.value)} />
        </div>
      </div>
      <p className="text-sm [overflow-wrap:anywhere]">
        Calculé : HT <strong className="tabular-nums">{formatDzd(totaux.ht)}</strong> · TVA {formatDzd(totaux.tva)}
        {totaux.taxe ? ` · ${e.taxes.extraTaxLabel ?? "Taxe"} ${formatDzd(totaux.taxe)}` : ""} · <strong className="tabular-nums">{formatDzd(totaux.ttc)} TTC</strong>
        <span className="text-muted-foreground"> — le total imprimé doit tomber dessus à un dinar près.</span>
      </p>
      <Erreur msg={err} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" size="sm" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Enregistrer la facture</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>Annuler</Button>
      </div>
    </form>
  );
}

// ───────────────────────── La réception d'une ligne ─────────────────────────

function ReceptionLigne({ id, l, options, run, saving, deplie = false }: {
  id: string; l: LigneFactureAffichee;
  options: Props["optionsReception"];
  run: (fn: () => Promise<ActionResult>, after?: () => void) => Promise<void>;
  saving: boolean;
  /** Ouvert d'emblée — la ligne du tableau a été ouverte par « J'ai reçu ». */
  deplie?: boolean;
}) {
  const [ouvert, setOuvert] = React.useState(deplie);
  const [catalogueId, setCatalogueId] = React.useState("");
  const choisi = options?.catalogue.find((c) => c.id === catalogueId) ?? null;
  const famille: FamillePromo | null = l.nature.type === "STOCK" ? l.nature.famille : choisi?.famille ?? null;
  const prestation = l.nature.type === "PRESTATION" || (l.nature.type === "A_CHOISIR" && !catalogueId);
  const numerique = famille != null && !familleQuantifiee(famille);

  if (!ouvert) {
    return (
      <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setOuvert(true)}>
        <PackageCheck className="h-4 w-4" /> {l.nature.type === "PRESTATION" ? "Faite" : "Réceptionner"}
      </Button>
    );
  }
  return (
    <form
      className="mt-2 space-y-2 rounded-md border border-border bg-background p-2"
      action={(f: FormData) => { f.set("promoMaterialId", id); f.set("ligneId", l.id); run(() => receptionnerLigneFacturePromo(f), () => setOuvert(false)); }}
    >
      {l.nature.type === "A_CHOISIR" && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <Label htmlFor={`rc-cat-${l.id}`}>{l.nature.obligatoire ? "Article du catalogue qui reçoit *" : "Article du catalogue (vide = prestation)"}</Label>
            <select id={`rc-cat-${l.id}`} name="catalogueId" value={catalogueId} onChange={(ev) => setCatalogueId(ev.target.value)} required={l.nature.obligatoire}
              className="h-10 w-full rounded-md border border-input bg-background px-2 text-base sm:h-9 sm:text-sm">
              <option value="">{l.nature.obligatoire ? "Choisir…" : "Aucun — c'est une prestation"}</option>
              {(options?.catalogue ?? []).map((c) => <option key={c.id} value={c.id}>{c.reference} — {c.nom}</option>)}
            </select>
          </div>
          {catalogueId && (
            <div>
              <Label htmlFor={`rc-prod-${l.id}`}>Produit(s){choisi?.exigeProduit ? " *" : ""}</Label>
              <select id={`rc-prod-${l.id}`} name="produitIds" multiple className="h-20 w-full rounded-md border border-input bg-background px-2 text-base sm:text-sm">
                {(options?.produits ?? []).map((p) => <option key={p.id} value={p.id}>{p.nom}</option>)}
              </select>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        {!numerique && (
          <div>
            <Label htmlFor={`rc-q-${l.id}`}>{prestation ? "Quantité faite" : "Quantité reçue"}</Label>
            <Input id={`rc-q-${l.id}`} name="quantiteRecue" defaultValue={String(l.quantite)} inputMode="decimal" className="w-28" />
          </div>
        )}
        {!prestation && famille != null && familleAValidite(famille) && (
          <div><Label htmlFor={`rc-v-${l.id}`}>Fin de validité</Label><Input id={`rc-v-${l.id}`} name="valableJusquau" type="date" /></div>
        )}
        {numerique && (
          <>
            <div><Label htmlFor={`rc-l-${l.id}`}>Lien du support</Label><Input id={`rc-l-${l.id}`} name="lien" inputMode="url" placeholder="https://…" /></div>
            <div><Label htmlFor={`rc-v-${l.id}`}>Valable jusqu&apos;au</Label><Input id={`rc-v-${l.id}`} name="valableJusquau" type="date" /></div>
          </>
        )}
        <Button type="submit" size="sm" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Confirmer</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOuvert(false)} disabled={saving} aria-label="Fermer"><X className="h-4 w-4" /></Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {prestation
          ? "Une prestation : elle est cochée « faite », rien n'entre au stock."
          : numerique
            ? "Un support numérique : son lien et sa validité vont au stock, sans quantité."
            : `Ce qui est reçu entre au magasin central${l.nature.type === "STOCK" ? ` (${l.nature.libelle})` : ""}, en un lot au coût de la facture. Rien n'est arrivé ? Ne cochez rien : au paiement, vous pourrez y renoncer.`}
      </p>
    </form>
  );
}

// ───────────────────────── Une facture ─────────────────────────

function Facture({ id, f, agir, canReceive, options, formalite, deplie = false }: {
  id: string; f: FactureAffichee; agir: boolean; canReceive: boolean; options: Props["optionsReception"];
  /** « J'ai reçu » : les réceptions à cocher s'ouvrent d'emblée. */
  deplie?: boolean;
  /** La formalité de la dernière demande du dossier — proposée d'office au paiement suivant. */
  formalite: string | null;
}) {
  const { saving, err, msg, run } = useRun();
  const saisir = useSaisir();
  const [annulation, setAnnulation] = React.useState(false);
  const detail = f.detail;
  const enAttente = detail ? detail.lignes.filter((l) => l.etat === "EN_ATTENTE" || l.etat === "PARTIELLE") : [];
  const recues = detail ? detail.lignes.filter((l) => l.quantiteRecue != null).length : 0;
  const receptionOuverte = canReceive && !f.paiementDemande;

  const demanderPaiement = (fd: FormData) => {
    fd.set("promoMaterialId", id); fd.set("invoiceId", f.id);
    if (enAttente.length > 0) {
      // LA CONFIRMATION QUE LA DIRECTION A DEMANDÉE (§118.165) : renoncer est définitif. Elle est
      // portée par le bouton décisif (le second clic, qui nomme les lignes), plus par une fenêtre.
      fd.set("confirmeRenoncement", "1");
    }
    run(() => demanderPaiementFacturePromo(fd));
  };

  return (
    <div className="space-y-2 rounded-md bg-muted/40 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium [overflow-wrap:anywhere]">Facture {f.reference ?? "sans numéro"}{f.montant != null ? ` — ${formatDzd(f.montant)} TTC` : ""}</p>
          <p className="text-xs text-muted-foreground">
            {f.date ? `du ${new Date(f.date).toLocaleDateString("fr-FR")} · ` : ""}{f.etatReglement}
            {f.demandeInfoMedicale ? ` · ${f.demandeInfoMedicale.nature} ${f.demandeInfoMedicale.reference}` : ""}
            {detail && enAttente.length > 0 && !f.paiementDemande ? ` · ${enAttente.length} ligne(s) à réceptionner` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {f.fichierId && <a className={lien} href={`/api/documents/${f.fichierId}`} target="_blank" rel="noreferrer"><FileText className="h-3.5 w-3.5" /> Fichier</a>}
          {agir && !f.paiementDemande && recues === 0 && !annulation && (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setAnnulation(true)}><Trash2 className="h-4 w-4" /> Annuler la facture</Button>
          )}
        </div>
      </div>

      {detail && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[560px]">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Ligne</th>
                <th className="py-1 pr-2 text-right font-medium">Facturé</th>
                <th className="py-1 pr-2 text-right font-medium">PU HT</th>
                <th className="py-1 pr-2 font-medium">Réception</th>
              </tr>
            </thead>
            <tbody>
              {detail.lignes.map((l) => (
                <tr key={l.id} className="border-t border-border align-top">
                  <td className="py-1 pr-2 font-medium sm:font-normal">
                    <div className="w-full">
                      {designationAvecAction(l.designation, l.action)}
                      {l.entree && <span className="block font-normal text-muted-foreground">Entré au magasin : {l.entree}</span>}
                    </div>
                  </td>
                  <td data-label="Facturé" className="py-1 pr-2 text-right tabular-nums">{nombre(l.quantite)}{l.unite ? ` ${l.unite}` : ""}</td>
                  <td data-label="PU HT" className="py-1 pr-2 text-right tabular-nums">{formatDzd(l.prixUnitaire)}</td>
                  {/* Sans intitulé au téléphone : la réception (et son formulaire) prend toute la largeur de la carte. */}
                  <td className="py-1 pr-2">
                    <div className="w-full">
                      <Badge tone={TON_ETAT[l.etat]}>{l.nature.type === "PRESTATION" && l.etat === "RECUE" ? "Faite" : ETAT_RECEPTION_LABEL[l.etat]}</Badge>
                      {l.quantiteRecue != null && l.etat !== "RECUE" && <span className="ml-1 tabular-nums text-muted-foreground">{nombre(l.quantiteRecue)} reçue(s)</span>}
                      {receptionOuverte && l.etat === "EN_ATTENTE" && <div className="mt-1"><ReceptionLigne id={id} l={l} options={options} run={run} saving={saving} deplie={deplie} /></div>}
                      {receptionOuverte && l.quantiteRecue != null && (
                        <Button size="sm" variant="ghost" className="mt-1" disabled={saving}
                          onClick={async () => {
                            // UN MOTIF, pas une simple confirmation (audit 360°, R17) : le journal doit dire si
                            // c'était une erreur de saisie ou une marchandise renvoyée. Abandonner la boîte ne fait rien.
                            const motif = await saisir({
                              titre: `Pourquoi annuler la réception de « ${l.designation} » ?`,
                              ...(l.entree ? { message: "Son entrée au magasin sera contre-passée." } : {}),
                              saisie: { libelle: "Motif (obligatoire)", obligatoire: true },
                            });
                            if (motif === null || !motif.trim()) return;
                            const fd = new FormData(); fd.set("promoMaterialId", id); fd.set("ligneId", l.id); fd.set("motif", motif.trim());
                            run(() => annulerReceptionLigneFacturePromo(fd));
                          }}>
                          <Undo2 className="h-3.5 w-3.5" /> Annuler la réception
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-muted-foreground">
            TVA {detail.tvaRate} %{detail.extraTaxRate ? ` · ${detail.extraTaxLabel ?? "Taxe"} ${detail.extraTaxRate} %` : ""}
            {detail.lignes.some((l) => l.action === null) ? " · lignes d'avant le vocabulaire des actions : la réception dit si elles entrent au stock" : ""}
          </p>
        </div>
      )}

      {annulation && (
        <form className="space-y-2 rounded-md border border-destructive/30 p-2" action={(fd: FormData) => { fd.set("promoMaterialId", id); fd.set("invoiceId", f.id); run(() => annulerFacturePromo(fd), () => setAnnulation(false)); }}>
          <Label htmlFor={`fa-ann-${f.id}`}>Pourquoi annuler cette facture ?</Label>
          <Textarea id={`fa-ann-${f.id}`} name="motif" required className="min-h-[50px]" placeholder="Doublon, facture erronée, rien n'a été livré… Elle reste au registre (annulée), avec ce motif." />
          <div className="flex flex-wrap gap-2">
            <BoutonDecisif type="submit" size="sm" variant="destructive" disabled={saving}>Annuler la facture</BoutonDecisif>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAnnulation(false)} disabled={saving}>Garder</Button>
          </div>
        </form>
      )}

      {agir && !f.paiementDemande && (
        <form className="flex flex-wrap items-center gap-2" action={demanderPaiement}>
          <ChoixFormalite name="formalite" defaut={formalite} />
          <InfoBulle label="Ce qui part avec le paiement" align="left">
            La demande de visa publicitaire — ou la déclaration au ministère — part à l&apos;information médicale avec ce paiement.
          </InfoBulle>
          {enAttente.length > 0 && <Input name="motifRenoncement" required aria-label="Motif du renoncement" placeholder="Motif (obligatoire) — ligne non livrée" className="w-full sm:w-64" />}
          <BoutonDecisif type="submit" size="sm" className={aLaLigne} variant={enAttente.length > 0 ? "outline" : "primary"} disabled={saving}
            confirmation={enAttente.length > 0 ? `renoncer à ${enAttente.map((l) => `« ${l.designation} »`).join(", ")} et demander le paiement` : undefined}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {enAttente.length > 0 ? " Demander le paiement malgré tout" : " Demander le paiement"}
          </BoutonDecisif>
          {enAttente.length > 0 && (
            <span className="w-full text-xs text-amber-700 dark:text-amber-400">
              Le paiement attend que tout soit reçu. Le demander maintenant, c&apos;est renoncer à payer ce qui manque — définitivement.
            </span>
          )}
        </form>
      )}
      {/* LE RATTRAPAGE — la demande à l'information médicale part AVEC le paiement ; si elle n'a pas pu partir (ou si le
          paiement est parti par un autre chemin), elle s'adresse ici. */}
      {agir && f.paiementDemande && !f.demandeInfoMedicale && (
        <form className="flex flex-wrap items-center gap-2" action={(fd: FormData) => { fd.set("promoMaterialId", id); fd.set("invoiceId", f.id); run(() => adresserInfoMedicaleFacturePromo(fd)); }}>
          <ChoixFormalite name="formalite" defaut={formalite} />
          <Button type="submit" size="sm" className={aLaLigne} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />} Adresser à l&apos;information médicale</Button>
        </form>
      )}
      <Erreur msg={err} />
      <Info msg={msg} />
    </div>
  );
}

// ───────────────────────── La frise d'un BC ─────────────────────────

/**
 * OÙ EN EST LE BC — une ligne par étape, et QUI a la main (Direction, 07/10 : « je ne sais pas si le BC a été envoyé aux
 * Finances ou pas »). Remplace la phrase « il part chez le fournisseur une fois signé ».
 */
function FriseBcPromo({ etape, libelleEtape, envoyeLe, envoyer }: { etape: string; libelleEtape: string; envoyeLe: string | null; envoyer: React.ReactNode }) {
  type Ton = "fait" | "en-cours" | "alerte" | "refus" | "a-venir";
  const signe = etape === "SIGNE";
  const lignes: { cle: string; ton: Ton; texte: string; extra?: React.ReactNode }[] = [{ cle: "genere", ton: "fait", texte: "BC généré" }];
  if (etape === "A_VALIDER") lignes.push({ cle: "centre", ton: "en-cours", texte: "En validation — centre Ad & Pro" });
  else if (etape === "A_REVOIR") lignes.push({ cle: "centre", ton: "alerte", texte: "À revoir — demandé par le centre" });
  else if (etape === "REFUSE") lignes.push({ cle: "centre", ton: "refus", texte: "Refusé par le centre" });
  else if (etape === "SANS_PORTE") lignes.push({ cle: "centre", ton: "alerte", texte: "À adresser au centre de validation" });
  else if (etape === "A_CORRIGER") lignes.push({ cle: "finances", ton: "alerte", texte: "Renvoyé par les Finances — à corriger" });
  else if (etape === "A_SIGNER") lignes.push({ cle: "finances", ton: "en-cours", texte: "Chez les Finances — en attente de signature" });
  else if (!signe) lignes.push({ cle: "etat", ton: "a-venir", texte: libelleEtape });
  lignes.push(signe ? { cle: "signe", ton: "fait", texte: "Signé par les Finances" } : { cle: "signe", ton: "a-venir", texte: "Signature des Finances" });
  lignes.push(envoyeLe
    ? { cle: "envoye", ton: "fait", texte: `Envoyé au fournisseur le ${new Date(envoyeLe).toLocaleDateString("fr-FR")}` }
    : signe ? { cle: "envoye", ton: "en-cours", texte: "À envoyer au fournisseur", extra: envoyer } : { cle: "envoye", ton: "a-venir", texte: "Envoi au fournisseur" });
  const style: Record<Ton, { classe: string; icone: React.ReactNode }> = {
    "fait": { classe: "text-success", icone: <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> },
    "en-cours": { classe: "font-medium text-primary", icone: <Clock className="h-3.5 w-3.5 shrink-0" /> },
    "alerte": { classe: "font-medium text-warning", icone: <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> },
    "refus": { classe: "font-medium text-destructive", icone: <XCircle className="h-3.5 w-3.5 shrink-0" /> },
    "a-venir": { classe: "text-muted-foreground", icone: <Circle className="h-3.5 w-3.5 shrink-0" /> },
  };
  return (
    <ol className="space-y-1 text-sm" aria-label="Étapes du bon de commande">
      {lignes.map((l) => (
        <li key={l.cle} className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 ${style[l.ton].classe}`}>
          {style[l.ton].icone}<span>{l.texte}</span>{l.extra}
        </li>
      ))}
    </ol>
  );
}

// ───────────────────────── Le détail d'un BC (un devis retenu) ─────────────────────────

type ModeBc = "modifier" | "supprimer" | "facture" | "reception" | null;

/**
 * LE DÉTAIL D'UNE LIGNE DU TABLEAU — sous le tableau, pleine largeur (au téléphone comme au bureau) : la frise du BC,
 * ses fichiers, la modification ou la suppression, le dépôt d'une facture, et chaque facture avec sa réception et son
 * paiement. Le geste ouvert arrive du « ⋯ » de la ligne (ou de « Ce qu'il reste à faire »).
 */
function DetailBc({ id, e, canPilot, canReceive, ouvert, options, mode, setMode, formalite }: {
  id: string; e: ExecutionAffichee; canPilot: boolean; canReceive: boolean; ouvert: boolean; options: Props["optionsReception"];
  mode: ModeBc; setMode: (m: ModeBc) => void; formalite: string | null;
}) {
  const { saving, err, msg, run } = useRun();
  const bc = e.bc;
  const signe = bc?.etape === "SIGNE";
  const fige = e.factures.length > 0;
  const agir = canPilot && ouvert;
  const resteAFacturer = e.lignesBC.some((l) => l.reste > 0);
  const form = (extra: Record<string, string>) => { const f = new FormData(); f.set("promoMaterialId", id); f.set("quoteId", e.quoteId); for (const [k, v] of Object.entries(extra)) f.set(k, v); return f; };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {e.reference ? `Devis n° ${e.reference} · ` : ""}{e.lignes} ligne{e.lignes > 1 ? "s" : ""} retenue{e.lignes > 1 ? "s" : ""} · {formatDzd(e.ttc)} TTC
      </p>

      {bc && (
        <FriseBcPromo
          etape={bc.etape} libelleEtape={bc.libelleEtape} envoyeLe={e.envoyeLe}
          envoyer={signe && !e.envoyeLe && agir
            ? <Button size="sm" variant="outline" className={aLaLigne} disabled={saving} onClick={() => run(() => marquerBonDeCommandeEnvoye(form({})))}><Send className="h-4 w-4" /> Marquer envoyé</Button>
            : null}
        />
      )}

      {bc && (
        <div className="flex flex-wrap items-center gap-2">
          {bc.pdf && <a className={lien} href={lienFichierEmis(bc.id, "pdf")} target="_blank" rel="noreferrer"><FileText className="h-3.5 w-3.5" /> PDF</a>}
          {bc.docx && <a className={lien} href={lienFichierEmis(bc.id, "docx", true)}><FileText className="h-3.5 w-3.5" /> Word</a>}
          <a className={lien} href={lienFichierEmis(bc.id, "xlsx", true)} aria-label="Générer ce bon de commande sur Excel"><FileText className="h-3.5 w-3.5" /> Excel</a>
          {agir && !fige && mode === null && (
            <>
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setMode("modifier")}><Pencil className="h-4 w-4" /> Modifier</Button>
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setMode("supprimer")}><Trash2 className="h-4 w-4" /> Supprimer</Button>
            </>
          )}
        </div>
      )}

      {mode === "modifier" && bc && (
        <form className="space-y-2 rounded-lg border border-border p-3" action={(f: FormData) => { f.set("promoMaterialId", id); f.set("quoteId", e.quoteId); run(() => modifierBonDeCommandePromo(f), () => setMode(null)); }}>
          <p className="flex items-center gap-1 text-sm font-medium">
            Modifier le bon de commande
            <InfoBulle label="Ce que change une modification" align="left">
              Un champ laissé vide garde sa valeur. Les lignes ne se modifient pas — elles sont ce qui a été validé. Une modification retire
              la signature des Finances : le BC est à signer de nouveau.
            </InfoBulle>
          </p>
          {bc.reference && (
            <div className="sm:max-w-sm">
              <ChampNumeroPiece depart={bc.reference} legalDocumentId={bc.id} name="numeroRevise" nameActuel="numeroActuel" label="N° de référence du BC"
                aide={`Changé seul (les autres champs laissés vides), le numéro ne relance pas le circuit : ${phraseNumeroSeul({ signe }).replace(/^Seul le numéro change : /, "")}`} />
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div><Label htmlFor={`bc-adr-${e.quoteId}`}>Adresse de livraison</Label><Input id={`bc-adr-${e.quoteId}`} name="livraisonAdresse" /></div>
            <div><Label htmlFor={`bc-del-${e.quoteId}`}>Délai de livraison</Label><Input id={`bc-del-${e.quoteId}`} name="livraisonDelai" placeholder="15 jours" /></div>
            <div><Label htmlFor={`bc-cn-${e.quoteId}`}>Interlocuteur</Label><Input id={`bc-cn-${e.quoteId}`} name="contactNom" /></div>
            <div><Label htmlFor={`bc-ct-${e.quoteId}`}>Téléphone</Label><Input id={`bc-ct-${e.quoteId}`} name="contactTelephone" type="tel" /></div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div><Label htmlFor={`bc-taxe-${e.quoteId}`}>Taxe supplémentaire (libellé)</Label><Input id={`bc-taxe-${e.quoteId}`} name="extraTaxLabel" placeholder="Taxe Pub" /></div>
            <div><Label htmlFor={`bc-taux-${e.quoteId}`}>Taux (%) — 0 la retire</Label><Input id={`bc-taux-${e.quoteId}`} name="extraTaxRate" inputMode="decimal" placeholder="2" /></div>
          </div>
          <div><Label htmlFor={`bc-notes-${e.quoteId}`}>Notes</Label><Textarea id={`bc-notes-${e.quoteId}`} name="notes" className="min-h-[50px]" /></div>
          <div><Label htmlFor={`bc-motif-${e.quoteId}`}>Motif de la modification</Label><Input id={`bc-motif-${e.quoteId}`} name="motif" /></div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" size="sm" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Enregistrer</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)} disabled={saving}>Annuler</Button>
          </div>
        </form>
      )}

      {mode === "supprimer" && bc && (
        <form className="space-y-2 rounded-lg border border-destructive/30 p-3" action={(f: FormData) => { f.set("promoMaterialId", id); f.set("quoteId", e.quoteId); run(() => annulerBonDeCommandePromo(f), () => setMode(null)); }}>
          <Label htmlFor={`bc-sup-${e.quoteId}`}>Pourquoi supprimer ce bon de commande ?</Label>
          <Textarea id={`bc-sup-${e.quoteId}`} name="motif" required className="min-h-[50px]" placeholder="Son numéro reste au registre (annulé), avec ce motif." />
          <div className="flex flex-wrap gap-2">
            <BoutonDecisif type="submit" size="sm" variant="destructive" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Supprimer le BC</BoutonDecisif>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)} disabled={saving}>Annuler</Button>
          </div>
        </form>
      )}

      {/* LES FACTURES DE CE BC — détaillées, chacune avec sa réception, son paiement et sa formalité. */}
      {bc && (e.factures.length > 0 || signe) && (
        <div className="space-y-2">
          {e.factures.map((f) => <Facture key={`${f.id}:${mode === "reception"}`} id={id} f={f} agir={agir} canReceive={canReceive && ouvert} options={options} formalite={formalite} deplie={mode === "reception"} />)}
          {agir && signe && resteAFacturer && mode !== "facture" && (
            <Button size="sm" variant="outline" className="w-full sm:w-auto" disabled={saving} onClick={() => setMode("facture")}><Upload className="h-4 w-4" /> Déposer une facture</Button>
          )}
          {mode === "facture" && <DepotFacture id={id} e={e} onDone={() => setMode(null)} onCancel={() => setMode(null)} />}
        </div>
      )}

      <Erreur msg={err} />
      <Info msg={msg} />
    </div>
  );
}

/** Les faits d'une ligne du tableau, dans la forme que lisent les pastilles et le geste (`promo-material/fiche.ts`). */
function faitsDeLaCommande(e: ExecutionAffichee): CommandeFaits {
  return {
    etape: e.bc?.etape ?? null, brouillon: !e.bc && e.brouillon !== null, envoyeLe: e.envoyeLe,
    resteAFacturer: !e.bc || e.lignesBC.some((l) => l.reste > 0),
    factures: e.factures.map((f) => {
      const lignes = f.detail?.lignes ?? [];
      const dates = lignes.map((l) => l.recueLe).filter((x): x is string => Boolean(x)).sort();
      return {
        lignes: lignes.length,
        enAttente: lignes.filter((l) => l.etat === "EN_ATTENTE" || l.etat === "PARTIELLE").length,
        recues: lignes.filter((l) => l.quantiteRecue != null).length,
        renoncees: lignes.filter((l) => l.renonce).length,
        derniereReception: dates.length ? dates[dates.length - 1] : null,
        paiementDemande: f.paiementDemande, reglee: f.reglee, etatReglement: f.etat, demandeIM: Boolean(f.demandeInfoMedicale),
      };
    }),
  };
}

const nombreDzd = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const Vide = () => <span className="text-muted-foreground">—</span>;
const PastilleOuVide = ({ p }: { p: Pastille | null }) => (p ? <Badge tone={p.ton} className="whitespace-nowrap">{p.texte}</Badge> : <Vide />);

/**
 * COMMANDES — UNE LIGNE PAR BC (maquette validée, étape 4 « Commande, livraison, paiement », 10/2026) : le fournisseur (et
 * ce qui est commandé), le BC (le PDF), le TTC, la livraison, la facture, le paiement, le visa ou la déclaration — chaque
 * état en une pastille — et UN bouton, le prochain geste de la personne qui regarde (« J'ai reçu », « Demander le
 * paiement », « Joindre la facture »). « ⋯ » garde tous les autres gestes (aperçu, fichiers, envoi, correction,
 * suppression, détail de la réception…). Le détail de la ligne choisie s'ouvre sous le tableau. Le total en pied.
 */
export function PromoExecutionCard({ id, executions, canPilot, canReceive, ouvert, optionsReception, peutValiderBc }: Props) {
  const { saving, err, msg, run } = useRun();
  const { rafraichir } = useRafraichir();
  const [options, setOptions] = React.useState(false);
  const [generer, setGenerer] = React.useState(false);
  const [choisi, setChoisi] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<ModeBc>(null);
  const [apercu, setApercu] = React.useState<string | null>(null);
  const [annonce, setAnnonce] = React.useState<string | null>(null);
  const detailRef = React.useRef<HTMLDivElement>(null);
  const aGenerer = executions.filter((e) => !e.bc && !e.brouillon).length;
  const agir = canPilot && ouvert;
  const formalite = formaliteDuDossier(executions.flatMap((e) => e.factures.map((f) => f.demandeInfoMedicale)));
  const total = totalDesCommandes(executions.map((e) => ({ ttc: e.bc?.montant ?? e.ttc })));
  const ouvrir = (quoteId: string, m: ModeBc) => {
    setChoisi(quoteId); setMode(m);
    window.setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  };

  // « Ce qu'il reste à faire » ouvre ici la bonne ligne, et le bon formulaire.
  useGeste((g) => {
    if (!g.quoteId) return;
    if (g.cle === "VERIFIER_BC") setApercu(g.quoteId);
    else if (g.cle === "MODIFIER_BC") ouvrir(g.quoteId, "modifier");
    else if (g.cle === "DEPOSER_FACTURE") ouvrir(g.quoteId, "facture");
    else if (g.cle === "RECEPTIONNER") ouvrir(g.quoteId, "reception");
    else ouvrir(g.quoteId, null);
  });

  const enApercu = apercu ? executions.find((e) => e.quoteId === apercu) ?? null : null;
  const detail = choisi ? executions.find((e) => e.quoteId === choisi) ?? null : null;

  const entrees = (e: ExecutionAffichee): EntreeMenu[] => {
    const bc = e.bc;
    const signe = bc?.etape === "SIGNE";
    const fige = e.factures.length > 0;
    const reste = e.lignesBC.some((l) => l.reste > 0);
    const aViser = e.factures.some((f) => f.paiementDemande && !f.demandeInfoMedicale);
    const form = () => { const f = new FormData(); f.set("promoMaterialId", id); f.set("quoteId", e.quoteId); return f; };
    return [
      ...(e.brouillon ? [{ libelle: peutValiderBc ? "Vérifier et valider l'aperçu" : "Voir l'aperçu", onClick: () => setApercu(e.quoteId) }] : []),
      ...(bc?.pdf ? [{ libelle: "PDF", href: lienFichierEmis(bc.id, "pdf") }] : []),
      ...(bc?.docx ? [{ libelle: "Word", href: lienFichierEmis(bc.id, "docx", true), telecharger: true }] : []),
      ...(bc ? [{ libelle: "Excel", href: lienFichierEmis(bc.id, "xlsx", true), telecharger: true }] : []),
      ...(agir && bc && signe && !e.envoyeLe ? [{ libelle: "Marquer envoyé au fournisseur", onClick: () => run(() => marquerBonDeCommandeEnvoye(form())), disabled: saving }] : []),
      ...(agir && bc && signe && reste ? [{ libelle: "Joindre une facture", onClick: () => ouvrir(e.quoteId, "facture") }] : []),
      ...(agir && aViser ? [{ libelle: "Adresser le visa / la déclaration", onClick: () => ouvrir(e.quoteId, null) }] : []),
      ...(agir && bc && !fige ? [{ libelle: "Modifier le BC", onClick: () => ouvrir(e.quoteId, "modifier") }] : []),
      ...(agir && bc && !fige ? [{ libelle: "Supprimer le BC", danger: true, onClick: () => ouvrir(e.quoteId, "supprimer") }] : []),
      ...(bc ? [{ libelle: "Détail, réception, paiement", onClick: () => ouvrir(e.quoteId, null) }] : []),
    ];
  };

  // La colonne figée (Fournisseur) garde un fond opaque — sur la ligne choisie comme ailleurs — et un filet à droite.
  const fige = (actif: boolean) => `sticky left-0 z-[1] min-w-[9.5rem] max-w-[11rem] shadow-[inset_-1px_0_0_hsl(var(--border))] sm:min-w-[12rem] sm:max-w-[16rem] ${actif ? "bg-accent" : "bg-card"}`;

  return (
    <section id="bc" className="surface scroll-mt-20 overflow-hidden" aria-labelledby="titre-bc">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id="titre-bc" className="flex items-center gap-1 text-[0.9375rem] font-semibold">
          Commandes
          <InfoBulle label="Comment avance une commande" align="left">
            Un seul bouton par ligne : le prochain geste. La demande de visa ou de déclaration part toute seule avec chaque
            paiement. Le dossier se clôt seul quand tout est reçu, payé et visé. Les autres gestes sont dans « ⋯ ».
          </InfoBulle>
        </h2>
        {agir && aGenerer > 0 && !generer && (
          <Button size="sm" variant="outline" onClick={() => setGenerer(true)}><Wand2 className="h-4 w-4" /> Préparer les BC ({aGenerer})</Button>
        )}
      </header>

      {executions.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Aucune ligne de devis n&apos;est retenue.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[54rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className={`${fige(false)} px-3 py-2 font-medium`}>Fournisseur</th>
                <th className="px-3 py-2 font-medium">BC</th>
                <th className="px-3 py-2 text-right font-medium">TTC</th>
                <th className="px-3 py-2 font-medium">Livraison</th>
                <th className="px-3 py-2 font-medium">Facture</th>
                <th className="px-3 py-2 font-medium">Paiement</th>
                <th className="px-3 py-2 font-medium">Visa / déclaration IM</th>
                <th className="px-3 py-2"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {executions.map((e) => {
                const faits = faitsDeLaCommande(e);
                const p = pastillesDeLaCommande(faits);
                const geste = gesteDeLaCommande(faits, { ouvert, pilote: canPilot, peutReceptionner: canReceive });
                const menu = entrees(e);
                const actif = choisi === e.quoteId;
                const visibles = e.articles.slice(0, 2);
                return (
                  <tr key={e.quoteId} className={`border-t border-border align-top ${actif ? "bg-accent" : ""}`}>
                    <td className={`${fige(actif)} px-3 py-2`}>
                      <span className="block font-semibold [overflow-wrap:anywhere]">{e.fournisseur}</span>
                      {visibles.map((a) => <span key={a} className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{a}</span>)}
                      {e.articles.length > visibles.length && <span className="block text-xs text-muted-foreground">+ {e.articles.length - visibles.length} autre{e.articles.length - visibles.length > 1 ? "s" : ""}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {e.bc
                        ? (e.bc.pdf
                          ? <a className="font-medium text-primary hover:underline" href={lienFichierEmis(e.bc.id, "pdf")} target="_blank" rel="noreferrer">{e.bc.reference ?? "Bon de commande"}</a>
                          : <span className="font-medium">{e.bc.reference ?? "Bon de commande"}</span>)
                        : e.brouillon
                          ? <button type="button" className="font-medium text-primary hover:underline" onClick={() => setApercu(e.quoteId)}>Aperçu</button>
                          : <Vide />}
                      {p.bc && <span className="mt-1 block"><Badge tone={p.bc.ton} className="whitespace-nowrap">{p.bc.texte}</Badge></span>}
                      {e.envoyeLe && <span className="block text-xs text-muted-foreground">envoyé le {jourMois(e.envoyeLe)}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{nombreDzd(e.bc?.montant ?? e.ttc)}</td>
                    <td className="px-3 py-2"><PastilleOuVide p={p.livraison} /></td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1">
                        <PastilleOuVide p={p.facture} />
                        {e.factures.length === 1 && e.factures[0].fichierId && (
                          <a className="text-muted-foreground hover:text-foreground" href={`/api/documents/${e.factures[0].fichierId}`} target="_blank" rel="noreferrer" aria-label="Ouvrir la facture"><FileText className="h-3.5 w-3.5" /></a>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2"><PastilleOuVide p={p.paiement} /></td>
                    <td className="px-3 py-2"><PastilleOuVide p={p.visa} /></td>
                    <td className="whitespace-nowrap px-2 py-2 text-right">
                      <span className="inline-flex items-center gap-1">
                        {geste && (
                          <Button size="sm" disabled={saving} onClick={() => ouvrir(e.quoteId, geste.cle === "DEPOSER_FACTURE" ? "facture" : geste.cle === "RECEPTIONNER" ? "reception" : null)}>
                            {geste.cle === "RECEPTIONNER" ? <PackageCheck className="h-4 w-4" /> : geste.cle === "DEPOSER_FACTURE" ? <Upload className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                            {geste.libelle}
                          </Button>
                        )}
                        {menu.length > 0 && <MenuLigne entrees={menu} label={`Actions — ${e.fournisseur}`} />}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-semibold">
                <td className={`${fige(false)} px-3 py-2`}>Total</td>
                <td className="px-3 py-2" />
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{nombreDzd(total)}</td>
                <td className="px-3 py-2" colSpan={5} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {(err || msg || annonce) && <div className="space-y-2 border-t border-border px-4 py-2.5"><Erreur msg={err} /><Info msg={msg ?? annonce} /></div>}

      {/* LE GESTE DE REPLI (§118.204) : les aperçus se préparent d'eux-mêmes à la dernière validation ; ce cadre ne sert qu'à
          ce qui n'a pas pu l'être, ou à régler la livraison et la taxe avant. Rien n'est numéroté ni envoyé ici. */}
      {agir && aGenerer > 0 && generer && (
        <div className="space-y-2 border-t border-border bg-primary/5 px-4 py-3">
          <p className="flex items-center gap-1 text-sm font-medium">
            {aGenerer} bon{aGenerer > 1 ? "s" : ""} de commande à préparer
            <InfoBulle label="Ce que fait la préparation" align="left">
              Un aperçu par fournisseur, d&apos;après les lignes validées — sans numéro. Le demandeur le relit, puis « Valider et envoyer aux
              Finances » attribue le numéro. Le message dit ce qui bloque, s&apos;il y a lieu.
            </InfoBulle>
          </p>
          <form className="space-y-2" action={(f: FormData) => { f.set("promoMaterialId", id); run(() => genererBonsDeCommandePromo(f), () => setGenerer(false)); }}>
            {/* LA CASE DES TAXES SUPPLÉMENTAIRES, toujours visible : « Taxe Pub 2 % » sur le HT, hors base de TVA. Vide = celle de chaque devis ; 0 = aucune. */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_9rem]">
              <div><Label htmlFor="gen-taxe">Taxe supplémentaire (libellé)</Label><Input id="gen-taxe" name="extraTaxLabel" placeholder="Taxe Pub" /></div>
              <div>
                <Label htmlFor="gen-taux" className="inline-flex items-center gap-1">
                  Taux (%)
                  <InfoBulle label="Comment la taxe est calculée">Calculée sur le HT, hors base de TVA. Vide : on garde celle de chaque devis ; 0 : aucune.</InfoBulle>
                </Label>
                <Input id="gen-taux" name="extraTaxRate" inputMode="decimal" placeholder="2" />
              </div>
            </div>
            {options && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div><Label htmlFor="gen-adr">Adresse de livraison</Label><Input id="gen-adr" name="livraisonAdresse" /></div>
                <div><Label htmlFor="gen-del">Délai de livraison</Label><Input id="gen-del" name="livraisonDelai" placeholder="15 jours" /></div>
                <div className="sm:col-span-2"><Label htmlFor="gen-notes">Notes</Label><Textarea id="gen-notes" name="notes" className="min-h-[50px]" /></div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <BoutonDecisif type="submit" size="sm" className={aLaLigne} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Générer les bons de commande (aperçus)</BoutonDecisif>
              {!options && <Button type="button" size="sm" variant="ghost" onClick={() => setOptions(true)}>Livraison et notes…</Button>}
              <Button type="button" size="sm" variant="ghost" onClick={() => setGenerer(false)}>Annuler</Button>
            </div>
          </form>
        </div>
      )}

      {detail && (
        <div ref={detailRef} className="space-y-2 border-t border-border px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">{detail.bc?.reference ? `BC ${detail.bc.reference}` : "Bon de commande"} — {detail.fournisseur}</p>
            <Button size="sm" variant="ghost" onClick={() => { setChoisi(null); setMode(null); }} aria-label="Fermer le détail"><X className="h-4 w-4" /></Button>
          </div>
          <DetailBc key={detail.quoteId} id={id} e={detail} canPilot={canPilot} canReceive={canReceive} ouvert={ouvert} options={optionsReception} mode={mode} setMode={setMode} formalite={formalite} />
        </div>
      )}

      {enApercu?.brouillon && (
        <ApercuBcPromo
          promoMaterialId={id} quoteId={enApercu.quoteId} fournisseur={enApercu.fournisseur} brouillon={enApercu.brouillon}
          peutValider={peutValiderBc} onClose={() => setApercu(null)}
          onDone={(r) => { setApercu(null); setAnnonce(r.message ?? null); rafraichir(); }}
        />
      )}
    </section>
  );
}
