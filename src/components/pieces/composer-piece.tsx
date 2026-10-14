"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FileText, Plus, Trash2, ArrowUp, ArrowDown, Eye } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { NATURES_AMONT } from "@/lib/legal/piece-emise";
import { PLURIEL_TYPE } from "@/lib/artifact/factory/commercial";
import {
  apercuAvantImpressionPiece, emettrePieceCommerciale, previsualiserPieceCommerciale, reglerNumerotationPieces,
  type ApercuPiece, type ResultatEmission,
} from "@/lib/actions/fabrique-actions";
import { ChampReference } from "@/components/references/champ-reference";

/**
 * COMPOSER UNE PIÈCE — le bouton des Finances (et de Legal) : une facture, un bon de commande ou
 * un devis au format de la société, sur son papier en-tête, en Word et en PDF.
 *
 * ── CE QUE L'ÉCRAN FAIT, ET CE QU'IL NE FAIT PAS ───────────────────────────────────────────
 *
 * Il SAISIT et il MONTRE. Il ne calcule rien : les totaux, la TVA, la somme en lettres et le
 * numéro prévu viennent de l'APERÇU serveur — la même composition que l'émission, jouée à blanc
 * — parce qu'un total calculé dans le navigateur et un total calculé par la fabrique finiraient
 * par diverger d'un centime, et c'est le centime qu'un comptable remarque (§118.5). Le même
 * formulaire (`construireFormData`) nourrit l'aperçu et l'émission : ce qu'on a vu est ce qui
 * est émis.
 *
 * L'émission passe par le registre Legal et le Drive ; le résultat rend les liens vers le Word,
 * le PDF et la fiche — et DIT comment le PDF a été produit (éditeur Office, ou rendu du serveur
 * dont le Word fait foi), parce que « le PDF existe » ne dit pas la même chose selon qui l'a
 * imprimé (§118.121).
 */

export type TypePieceComposable = "FACTURE" | "BON_DE_COMMANDE" | "DEVIS";

const LIBELLE: Record<TypePieceComposable, { nom: string; bouton: string; tiers: string; article: string }> = {
  FACTURE: { nom: "Facture", bouton: "Composer une facture", tiers: "Client", article: "la facture" },
  BON_DE_COMMANDE: { nom: "Bon de commande", bouton: "Composer un bon de commande", tiers: "Fournisseur", article: "le bon de commande" },
  DEVIS: { nom: "Devis", bouton: "Composer un devis", tiers: "Client", article: "le devis" },
};

interface Ligne { id: number; designation: string; details: string; quantite: string; prix: string; remise: string; tva: string; section: boolean }
interface Taxe { id: number; libelle: string; taux: string }

/**
 * LES PIÈCES AMONT QU'ON PEUT CHOISIR (audit 360°, lot D1c — F1) — chargées par la porte de la liste Legal
 * (`piecesAmontComposables`) : la société de l'en-tête, les lecteurs désignés, les natures ouvertes. Une nature
 * que la personne ne lit pas n'est pas chargée : elle est NOMMÉE (`fermees`), pour que l'écran dise pourquoi le
 * menu est vide ; une nature coupée à `limite` pièces l'est aussi (`tronquees`).
 */
export interface AmontComposable {
  options: { value: string; label: string; kind: string; companyId: string | null }[];
  tronquees: string[];
  fermees: string[];
  limite: number;
}

export interface ComposerPieceProps {
  typeInitial: TypePieceComposable;
  typesAutorises: TypePieceComposable[];
  societes: { id: string; label: string }[];
  societeParDefaut: string | null;
  letterheads: { id: string; name: string; companyId: string | null; companyLabel: string | null }[];
  peutReglerNumerotation: boolean;
  amont: AmontComposable;
  /**
   * COMPOSÉ DEPUIS « DEMANDES DE VALIDATIONS » (pré-validation d'un BC, 10/2026) : la pièce naît retenue — aucun centre
   * ne la voit avant la validation finale — et l'émission rend la main au formulaire (`onEmis`) au lieu d'ouvrir la fiche.
   */
  prevalidation?: boolean;
  onEmis?: (piece: { legalDocumentId: string; reference: string }) => void;
}

const aujourdhui = (): string => new Date().toISOString().slice(0, 10);
let compteur = 1;
const nouvelleLigne = (section = false): Ligne => ({ id: compteur++, designation: "", details: "", quantite: section ? "" : "1", prix: "", remise: "", tva: "", section });

export function ComposerPieceButton(props: ComposerPieceProps) {
  const [open, setOpen] = React.useState(false);
  const lib = LIBELLE[props.typeInitial];
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <FileText className="h-4 w-4" aria-hidden />
        {lib.bouton}
      </Button>
      {open && <ComposerPieceSheet {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function ComposerPieceSheet(props: ComposerPieceProps & { onClose: () => void }) {
  const router = useRouter();
  const [type, setType] = React.useState<TypePieceComposable>(props.typeInitial);
  const [societe, setSociete] = React.useState<string>(props.societeParDefaut ?? props.societes[0]?.id ?? "");
  const [letterheadId, setLetterheadId] = React.useState<string>("");
  const [amont, setAmont] = React.useState<string>("");
  const [tiers, setTiers] = React.useState({ nom: "", adresse: "", telephone: "", email: "", rc: "", nif: "", ai: "", nis: "" });
  const [champs, setChamps] = React.useState({
    numeroClient: "", date: aujourdhui(), echeance: "", validiteJours: "30", objet: "", referenceAmont: "", referenceAmontDate: "",
    contactNom: "", contactTelephone: "", livraisonAdresse: "", livraisonDelai: "", modePaiement: "VIREMENT", conditionsPaiement: "",
    tvaDefaut: "19", remiseGlobale: "", notes: "",
  });
  const [lignes, setLignes] = React.useState<Ligne[]>([nouvelleLigne()]);
  // LA CASE DES TAXES SUPPLÉMENTAIRES est TOUJOURS là (Direction, 10/2026) : une ligne vide attend « Taxe Pub » et son taux —
  // elle n'est envoyée que remplie (le serveur écarte une ligne sans libellé ni taux), et la dernière ligne retirée se vide au lieu de disparaître.
  const [taxes, setTaxes] = React.useState<Taxe[]>([{ id: 0, libelle: "", taux: "" }]);
  const [apercu, setApercu] = React.useState<ApercuPiece | { ok: false; error: string } | null>(null);
  const [resultat, setResultat] = React.useState<ResultatEmission | null>(null);
  const [motif, setMotif] = React.useState<string>("");
  const [motifMessage, setMotifMessage] = React.useState<string | null>(null);
  const [depart, setDepart] = React.useState<string>("");
  // La référence saisie au registre commun NNN/DG/AAAA (quand la pièce y va) : la saisie, la proposition, et son refus en direct.
  const [reference, setReference] = React.useState({ valeur: "", suggeree: "", refusee: false });
  // L'APERÇU AVANT IMPRESSION : le PDF de la pièce à blanc, en blob local — jamais un fichier du Drive.
  const [impression, setImpression] = React.useState<{ url: string; pages: number; numero: string } | null>(null);
  const [impressionErreur, setImpressionErreur] = React.useState<string | null>(null);
  const [rendu, startRendu] = React.useTransition();
  const [emission, startEmission] = React.useTransition();
  const [chargement, startChargement] = React.useTransition();
  const lib = LIBELLE[type];

  const papiers = React.useMemo(
    () => props.letterheads.filter((l) => !l.companyId || l.companyId === societe),
    [props.letterheads, societe],
  );

  // LE MENU « FAIT SUITE À » (lot D1c — F1) : les natures que la fabrique accepte pour CE type (`NATURES_AMONT`,
  // la même table que la fabrique), et de la société émettrice — la fabrique refuse la pièce d'une autre
  // société : le menu ne la propose pas (§118.83). La pièce n'est envoyée que si le menu la propose ENCORE :
  // changer de nature ou de société n'envoie pas une pièce qu'on ne voit plus.
  const naturesAmont: readonly string[] = NATURES_AMONT[type];
  const optionsAmont = props.amont.options;
  const amontsProposes = React.useMemo(
    () => optionsAmont.filter((o) => naturesAmont.includes(o.kind) && (!o.companyId || o.companyId === societe)),
    [optionsAmont, naturesAmont, societe],
  );
  const amontRetenu = amontsProposes.some((o) => o.value === amont) ? amont : "";
  const amontFermees = props.amont.fermees.filter((k) => naturesAmont.includes(k));
  const amontTronquees = props.amont.tronquees.filter((k) => naturesAmont.includes(k));

  // LE MÊME FORMULAIRE pour l'aperçu et l'émission : ce qu'on a vu est ce qui est émis.
  const construireFormData = React.useCallback((): FormData => {
    const fd = new FormData();
    fd.set("type", type);
    fd.set("societe", societe);
    if (props.prevalidation) fd.set("prevalidation", "1");
    if (letterheadId) fd.set("letterheadId", letterheadId);
    for (const [k, v] of Object.entries(tiers)) fd.set(`tiers${k[0].toUpperCase()}${k.slice(1)}`, v);
    for (const [k, v] of Object.entries(champs)) fd.set(k, v);
    for (const l of lignes) {
      fd.append("ligneDesignation", l.designation);
      fd.append("ligneDetails", l.details);
      fd.append("ligneQuantite", l.quantite);
      fd.append("lignePrix", l.prix);
      fd.append("ligneRemise", l.remise);
      fd.append("ligneTva", l.tva);
      fd.append("ligneSection", l.section ? "1" : "0");
    }
    for (const t of taxes) { fd.append("taxeLibelle", t.libelle); fd.append("taxeTaux", t.taux); }
    if (amontRetenu) fd.set("chainFromId", amontRetenu);
    return fd;
  }, [type, societe, letterheadId, tiers, champs, lignes, taxes, amontRetenu, props.prevalidation]);

  // L'APERÇU suit la saisie, avec un demi-seconde de retenue : assez pour ne pas appeler le
  // serveur à chaque touche, assez peu pour que les totaux paraissent vivants.
  const pret = tiers.nom.trim() !== "" && lignes.some((l) => !l.section && l.designation.trim() !== "");
  const empreinte = JSON.stringify({ type, societe, letterheadId, tiers, champs, lignes, taxes, amontRetenu });
  // Un aperçu d'avant la dernière frappe n'est plus l'aperçu : il se ferme (et libère son blob) plutôt que de montrer un document périmé.
  React.useEffect(() => { setImpression(null); setImpressionErreur(null); }, [empreinte]);
  React.useEffect(() => () => { if (impression) URL.revokeObjectURL(impression.url); }, [impression]);
  React.useEffect(() => {
    if (!pret || resultat) return;
    const fd = construireFormData();
    const t = setTimeout(() => {
      startChargement(async () => {
        const r = await previsualiserPieceCommerciale(undefined, fd);
        setApercu(r);
        if (r.ok && !motif) setMotif(r.motif ?? "");
      });
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empreinte, pret, resultat]);

  const modifierLigne = (id: number, patch: Partial<Ligne>) => setLignes((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const deplacer = (id: number, sens: -1 | 1) => setLignes((ls) => {
    const i = ls.findIndex((l) => l.id === id);
    const j = i + sens;
    if (i < 0 || j < 0 || j >= ls.length) return ls;
    const copie = [...ls];
    [copie[i], copie[j]] = [copie[j], copie[i]];
    return copie;
  });

  const emettre = () => {
    const fd = construireFormData();
    // LA RÉFÉRENCE (registre commun NNN/DG/AAAA) : envoyée à l'ÉMISSION seulement — l'aperçu montre le numéro prévu.
    if (apercu && apercu.ok && apercu.surRegistre) { fd.set("numeroChoisi", reference.valeur); fd.set("numeroSuggere", reference.suggeree); }
    startEmission(async () => {
      const r = await emettrePieceCommerciale(undefined, fd);
      setResultat(r);
      // RENDRE LA MAIN au formulaire qui a ouvert le compositeur : il attache la pièce émise à sa demande.
      if (r.ok && r.legalDocumentId && props.onEmis) {
        props.onEmis({ legalDocumentId: r.legalDocumentId, reference: r.reference ?? "" });
        props.onClose();
        return;
      }
      // LA PIÈCE S'AFFICHE (§118.209) : « il doit s'afficher, pas juste se sauvegarder dans Legal et qu'on aille le
      // rechercher ». L'émission mène à la fiche, où le PDF est ouvert sous la phrase de succès. Quand la fiche
      // est fermée à la personne (`lien` nul), le panneau reste ouvert sur ses liens — le PDF s'ouvre sous la porte de la pièce.
      if (r.ok && r.lien) router.push(r.lien);
      else if (r.ok) router.refresh();
    });
  };

  const voirImpression = () => {
    const fd = construireFormData();
    setImpressionErreur(null);
    startRendu(async () => {
      const r = await apercuAvantImpressionPiece(undefined, fd);
      if (!r.ok) { setImpression(null); setImpressionErreur(r.error); return; }
      const octets = Uint8Array.from(atob(r.pdfBase64), (c) => c.charCodeAt(0));
      setImpression({ url: URL.createObjectURL(new Blob([octets], { type: "application/pdf" })), pages: r.pages, numero: r.numeroProchain });
    });
  };

  const enregistrerMotif = () => {
    const fd = new FormData();
    fd.set("type", type); fd.set("societe", societe); fd.set("motif", motif);
    // Le premier numéro n'est envoyé que s'il est saisi : une clé absente garde le départ réglé (§118.152c).
    if (depart.trim() !== "") { fd.set("depart", depart.trim()); fd.set("annee", champs.date.slice(0, 4)); }
    startChargement(async () => {
      const r = await reglerNumerotationPieces(undefined, fd);
      setMotifMessage(r.ok ? r.message ?? "Enregistré." : r.error ?? "Refusé.");
      if (r.ok) setApercu(await previsualiserPieceCommerciale(undefined, construireFormData()));
    });
  };

  const totaux = apercu && apercu.ok ? apercu.totaux : null;
  const bloquants = apercu && apercu.ok ? apercu.bloquants : apercu && !apercu.ok ? [apercu.error] : [];
  const peutEmettre = !!(apercu && apercu.ok && apercu.peutEmettre) && !emission && !resultat?.ok && !(apercu.surRegistre && reference.refusee);

  return (
    <Sheet
      open
      onClose={props.onClose}
      title={lib.bouton}
      description="Au format de la société, sur son papier en-tête, en Word et en PDF — numérotée par son compteur et inscrite au registre."
      width="xl"
      footer={
        resultat?.ok ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">Pièce émise.</span>
            <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
              <Button type="button" variant="outline" onClick={() => { setResultat(null); setLignes([nouvelleLigne()]); setTiers({ nom: "", adresse: "", telephone: "", email: "", rc: "", nif: "", ai: "", nis: "" }); setAmont(""); setApercu(null); }}>
                Composer une autre pièce
              </Button>
              <Button type="button" onClick={props.onClose}>Fermer</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">
              {apercu && apercu.ok ? `Numéro prévu : ${apercu.numeroProchain}` : pret ? (chargement ? "Calcul…" : "") : "Renseignez le tiers et au moins une ligne."}
            </span>
            <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
              <Button type="button" variant="outline" onClick={props.onClose}>Annuler</Button>
              <Button type="button" onClick={emettre} disabled={!peutEmettre}>{emission ? "Émission…" : `Émettre ${lib.article}`}</Button>
            </div>
          </div>
        )
      }
    >
      <div className="space-y-5 text-sm">
        {/* ── Nature, société, papier ── */}
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="cp-type">Nature</Label>
            <Select id="cp-type" value={type} onChange={(e) => { setType(e.target.value as TypePieceComposable); setResultat(null); }}>
              {props.typesAutorises.map((t) => <option key={t} value={t}>{LIBELLE[t].nom}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="cp-societe">Société émettrice</Label>
            <Select id="cp-societe" value={societe} onChange={(e) => { setSociete(e.target.value); setLetterheadId(""); }}>
              {props.societes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="cp-papier">Papier en-tête</Label>
            <Select id="cp-papier" value={letterheadId} onChange={(e) => setLetterheadId(e.target.value)}>
              <option value="">{apercu && apercu.ok ? (apercu.papierEnTete ? `Celui du profil — ${apercu.papierEnTete.nom}` : "Aucun papier : mise en page neutre") : "Celui du profil de la société"}</option>
              {papiers.map((l) => <option key={l.id} value={l.id}>{l.name}{l.companyLabel ? ` — ${l.companyLabel}` : " — commun au groupe"}</option>)}
            </Select>
          </div>
        </section>

        {/* ── Le tiers ── */}
        <section className="space-y-2">
          <h3 className="font-semibold">{lib.tiers}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="cp-tiers-nom">Raison sociale *</Label>
              <Input id="cp-tiers-nom" value={tiers.nom} onChange={(e) => setTiers({ ...tiers, nom: e.target.value })} placeholder="Sarl BIOGALENIC" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cp-tiers-adresse">Adresse (une ligne par retour)</Label>
              <Textarea id="cp-tiers-adresse" rows={2} value={tiers.adresse} onChange={(e) => setTiers({ ...tiers, adresse: e.target.value })} />
            </div>
            <div><Label htmlFor="cp-tiers-tel">Téléphone / Fax</Label><Input id="cp-tiers-tel" type="tel" inputMode="tel" value={tiers.telephone} onChange={(e) => setTiers({ ...tiers, telephone: e.target.value })} /></div>
            <div><Label htmlFor="cp-tiers-email">E-mail</Label><Input id="cp-tiers-email" inputMode="email" autoCapitalize="off" spellCheck={false} value={tiers.email} onChange={(e) => setTiers({ ...tiers, email: e.target.value })} /></div>
            <div><Label htmlFor="cp-tiers-rc">RC</Label><Input id="cp-tiers-rc" value={tiers.rc} onChange={(e) => setTiers({ ...tiers, rc: e.target.value })} /></div>
            <div><Label htmlFor="cp-tiers-nif">NIF</Label><Input id="cp-tiers-nif" value={tiers.nif} onChange={(e) => setTiers({ ...tiers, nif: e.target.value })} /></div>
            <div><Label htmlFor="cp-tiers-ai">AI</Label><Input id="cp-tiers-ai" value={tiers.ai} onChange={(e) => setTiers({ ...tiers, ai: e.target.value })} /></div>
            <div><Label htmlFor="cp-tiers-nis">NIS</Label><Input id="cp-tiers-nis" value={tiers.nis} onChange={(e) => setTiers({ ...tiers, nis: e.target.value })} /></div>
            {type === "FACTURE" && (
              <div><Label htmlFor="cp-numero-client">Numéro de client</Label><Input id="cp-numero-client" value={champs.numeroClient} onChange={(e) => setChamps({ ...champs, numeroClient: e.target.value })} placeholder="00003" /></div>
            )}
          </div>
        </section>

        {/* ── Références ── */}
        <section className="space-y-2">
          <h3 className="font-semibold">Références</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {naturesAmont.length > 0 && (
              <div className="sm:col-span-3">
                <Label htmlFor="cp-amont">Fait suite à (pièce du registre)</Label>
                <Select id="cp-amont" value={amontRetenu} onChange={(e) => setAmont(e.target.value)}>
                  <option value="">— Aucune : pièce isolée —</option>
                  {amontsProposes.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {type === "BON_DE_COMMANDE"
                    ? "Chaîné à son devis, le bon de commande suit la demande dont le devis est né (centre de validation Ad & Pro pour une demande Ad & Pro), et le devis ne se révise plus."
                    : "Chaînée à sa pièce amont, la facture la fige : la pièce dont elle découle ne se révise plus."}
                  {amontFermees.includes("QUOTE") && " Les devis ne vous sont pas ouverts : Legal peut rattacher cette pièce depuis sa fiche (« Modifier » › « Fait suite à »)."}
                  {amontTronquees.length > 0 && ` Seules les ${props.amont.limite} pièces les plus récentes de chaque nature sont proposées.`}
                </p>
              </div>
            )}
            <div><Label htmlFor="cp-date">Date d'émission</Label><Input id="cp-date" type="date" value={champs.date} onChange={(e) => setChamps({ ...champs, date: e.target.value })} /></div>
            {type === "FACTURE" && <div><Label htmlFor="cp-echeance">Échéance de règlement</Label><Input id="cp-echeance" type="date" value={champs.echeance} onChange={(e) => setChamps({ ...champs, echeance: e.target.value })} /></div>}
            {type === "DEVIS" && <div><Label htmlFor="cp-validite">Validité (jours)</Label><Input id="cp-validite" type="number" min={1} max={365} value={champs.validiteJours} onChange={(e) => setChamps({ ...champs, validiteJours: e.target.value })} /></div>}
            <div className={type === "FACTURE" ? "" : "sm:col-span-2"}>
              <Label htmlFor="cp-objet">{type === "FACTURE" ? "Document Ref" : "Objet"}</Label>
              <Input id="cp-objet" value={champs.objet} onChange={(e) => setChamps({ ...champs, objet: e.target.value })} />
            </div>
            <div><Label htmlFor="cp-ref-amont">{type === "BON_DE_COMMANDE" ? "Devis N° (du fournisseur)" : "Référence amont"}</Label><Input id="cp-ref-amont" value={champs.referenceAmont} onChange={(e) => setChamps({ ...champs, referenceAmont: e.target.value })} placeholder="26/0576" /></div>
            <div><Label htmlFor="cp-ref-amont-date">Date de la pièce amont</Label><Input id="cp-ref-amont-date" type="date" value={champs.referenceAmontDate} onChange={(e) => setChamps({ ...champs, referenceAmontDate: e.target.value })} /></div>
            <div>
              <Label htmlFor="cp-mode">Mode de paiement</Label>
              <Select id="cp-mode" value={champs.modePaiement} onChange={(e) => setChamps({ ...champs, modePaiement: e.target.value })}>
                <option value="VIREMENT">Virement bancaire</option>
                <option value="CHEQUE">Chèque</option>
                <option value="ESPECES">Espèces (droit de timbre)</option>
                <option value="AUTRE">À convenir</option>
                <option value="">Non précisé</option>
              </Select>
            </div>
            <div className="sm:col-span-2"><Label htmlFor="cp-conditions">Conditions de paiement</Label><Input id="cp-conditions" value={champs.conditionsPaiement} onChange={(e) => setChamps({ ...champs, conditionsPaiement: e.target.value })} placeholder="ou virement bancaire · 30 jours date de facture" /></div>
            {type !== "FACTURE" && (
              <>
                <div><Label htmlFor="cp-contact-nom">Contact</Label><Input id="cp-contact-nom" value={champs.contactNom} onChange={(e) => setChamps({ ...champs, contactNom: e.target.value })} placeholder="Mme ABDELAZIZ ASSIA" /></div>
                <div><Label htmlFor="cp-contact-tel">Téléphone du contact</Label><Input id="cp-contact-tel" type="tel" inputMode="tel" value={champs.contactTelephone} onChange={(e) => setChamps({ ...champs, contactTelephone: e.target.value })} /></div>
              </>
            )}
            {type === "BON_DE_COMMANDE" && (
              <>
                <div className="sm:col-span-2"><Label htmlFor="cp-livraison">Adresse de livraison (vide = le siège de la société)</Label><Input id="cp-livraison" value={champs.livraisonAdresse} onChange={(e) => setChamps({ ...champs, livraisonAdresse: e.target.value })} /></div>
                <div><Label htmlFor="cp-delai">Délai de livraison</Label><Input id="cp-delai" value={champs.livraisonDelai} onChange={(e) => setChamps({ ...champs, livraisonDelai: e.target.value })} /></div>
              </>
            )}
          </div>
        </section>

        {/* ── Les lignes ── */}
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Lignes</h3>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setLignes([...lignes, nouvelleLigne(true)])}>Titre de section</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setLignes([...lignes, nouvelleLigne()])}><Plus className="h-4 w-4" aria-hidden />Ligne</Button>
            </div>
          </div>
          <div className="space-y-2">
            {lignes.map((l, i) => (
              <div key={l.id} className={`rounded-lg border border-border p-2 ${l.section ? "bg-secondary/40" : "bg-card"}`}>
                <div className="grid grid-cols-12 gap-2">
                  <div className={l.section ? "col-span-12 sm:col-span-10" : "col-span-12 sm:col-span-5"}>
                    <Input aria-label={l.section ? `Titre de section ${i + 1}` : `Désignation ${i + 1}`} value={l.designation} onChange={(e) => modifierLigne(l.id, { designation: e.target.value })} placeholder={l.section ? "Campagne Raltégravir" : "Désignation"} />
                    {!l.section && (
                      <Textarea className="mt-1" rows={1} aria-label={`Détails de la ligne ${i + 1}`} value={l.details} onChange={(e) => modifierLigne(l.id, { details: e.target.value })} placeholder="Détails (une ligne par retour) : Format A4, Impression quadri…" />
                    )}
                  </div>
                  {!l.section && (
                    <>
                      {/* Au téléphone, deux champs par rangée : quatre sur un tiers de largeur ne laissaient rien lire. */}
                      <div className="col-span-6 sm:col-span-2"><Input aria-label="Quantité" inputMode="decimal" value={l.quantite} onChange={(e) => modifierLigne(l.id, { quantite: e.target.value })} placeholder="Qté" /></div>
                      <div className="col-span-6 sm:col-span-2"><Input aria-label="Prix unitaire HT" inputMode="decimal" value={l.prix} onChange={(e) => modifierLigne(l.id, { prix: e.target.value })} placeholder="PU HT (0 = Offert)" /></div>
                      <div className="col-span-6 sm:col-span-1"><Input aria-label="Remise %" inputMode="decimal" value={l.remise} onChange={(e) => modifierLigne(l.id, { remise: e.target.value })} placeholder="Rem. %" /></div>
                      <div className="col-span-6 sm:col-span-1">
                        <Select aria-label="TVA de la ligne" value={l.tva} onChange={(e) => modifierLigne(l.id, { tva: e.target.value })}>
                          <option value="">TVA déf.</option><option value="19">19 %</option><option value="9">9 %</option><option value="0">0 %</option>
                        </Select>
                      </div>
                    </>
                  )}
                  <div className={`${l.section ? "col-span-12 sm:col-span-2" : "col-span-12 sm:col-span-1"} flex items-start justify-end gap-1`}>
                    <button type="button" className="rounded p-2 text-muted-foreground hover:bg-secondary sm:p-1" aria-label="Monter" onClick={() => deplacer(l.id, -1)}><ArrowUp className="h-4 w-4" /></button>
                    <button type="button" className="rounded p-2 text-muted-foreground hover:bg-secondary sm:p-1" aria-label="Descendre" onClick={() => deplacer(l.id, 1)}><ArrowDown className="h-4 w-4" /></button>
                    <button type="button" className="rounded p-2 text-muted-foreground hover:bg-secondary sm:p-1" aria-label="Supprimer la ligne" onClick={() => setLignes(lignes.filter((x) => x.id !== l.id))}><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="cp-tva-defaut">TVA par défaut</Label>
              <Select id="cp-tva-defaut" value={champs.tvaDefaut} onChange={(e) => setChamps({ ...champs, tvaDefaut: e.target.value })}>
                <option value="19">19 %</option><option value="9">9 %</option><option value="0">0 % (exonéré)</option>
              </Select>
            </div>
            <div><Label htmlFor="cp-remise-globale">Remise globale (%)</Label><Input id="cp-remise-globale" inputMode="decimal" value={champs.remiseGlobale} onChange={(e) => setChamps({ ...champs, remiseGlobale: e.target.value })} /></div>
          </div>
        </section>

        {/* ── Taxes additionnelles ── */}
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Taxes supplémentaires <span className="font-normal text-muted-foreground">(sur le HT, hors base de TVA)</span></h3>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setTaxes([...taxes.filter((x) => x.libelle.trim() !== "" || x.taux.trim() !== ""), { id: compteur++, libelle: "Taxe Pub", taux: "2" }])}>Taxe Pub 2 %</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setTaxes([...taxes, { id: compteur++, libelle: "", taux: "" }])}><Plus className="h-4 w-4" aria-hidden />Taxe</Button>
            </div>
          </div>
          {taxes.map((t) => (
            <div key={t.id} className="grid grid-cols-12 gap-2">
              <div className="col-span-7"><Input aria-label="Libellé de la taxe" value={t.libelle} onChange={(e) => setTaxes(taxes.map((x) => (x.id === t.id ? { ...x, libelle: e.target.value } : x)))} placeholder="Taxe Pub" /></div>
              <div className="col-span-3"><Input aria-label="Taux de la taxe en %" inputMode="decimal" value={t.taux} onChange={(e) => setTaxes(taxes.map((x) => (x.id === t.id ? { ...x, taux: e.target.value } : x)))} placeholder="%" /></div>
              <div className="col-span-2 flex justify-end"><button type="button" className="rounded p-2 text-muted-foreground hover:bg-secondary sm:p-1" aria-label="Retirer la taxe" onClick={() => setTaxes(taxes.length <= 1 ? [{ id: compteur++, libelle: "", taux: "" }] : taxes.filter((x) => x.id !== t.id))}><Trash2 className="h-4 w-4" /></button></div>
            </div>
          ))}
        </section>

        <section>
          <Label htmlFor="cp-notes">Notes (imprimées sous les totaux)</Label>
          <Textarea id="cp-notes" rows={2} value={champs.notes} onChange={(e) => setChamps({ ...champs, notes: e.target.value })} />
        </section>

        {/* ── L'aperçu : ce que la fabrique a calculé, pas le navigateur ── */}
        <section className="rounded-lg border border-border bg-secondary/30 p-3" aria-live="polite">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold">Aperçu</h3>
            {apercu && apercu.ok && (
              <span className="text-xs text-muted-foreground">
                {apercu.societe.nom} · numéro prévu <b>{apercu.numeroProchain}</b> · {apercu.papierEnTete ? `papier « ${apercu.papierEnTete.nom} »` : "sans papier en-tête"} · PDF {apercu.pdfParEditeur ? "par l'éditeur Office" : "rendu du serveur"}
              </span>
            )}
          </div>
          {apercu && apercu.ok && apercu.surRegistre && !resultat?.ok && (
            <div className="mt-2 max-w-xs">
              <ChampReference
                label="Référence" name="numeroChoisi" nameSuggeree="numeroSuggere" cle={`${apercu.societe.id}:${champs.date.slice(0, 4)}`}
                annee={Number(champs.date.slice(0, 4)) || undefined}
                charger={async () => ({ ok: true, actif: true, societeId: apercu.societe.id, prochaine: apercu.numeroProchain })}
                onChange={(e) => setReference({ valeur: e.valeur, suggeree: e.suggeree ?? "", refusee: e.erreur !== null })}
              />
            </div>
          )}
          {totaux ? (
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              <dt className="text-muted-foreground">Total HT</dt><dd className="text-right tabular-nums">{formatCurrency(totaux.totalHt)}</dd>
              {totaux.taxes.map((x) => (
                <React.Fragment key={x.libelle}>
                  <dt className="text-muted-foreground">{x.libelle} {Math.round(x.taux * 10000) / 100} %</dt><dd className="text-right tabular-nums">{formatCurrency(x.montant)}</dd>
                </React.Fragment>
              ))}
              {totaux.tva.map((x) => (
                <React.Fragment key={x.taux}>
                  <dt className="text-muted-foreground">TVA {Math.round(x.taux * 100)} %</dt><dd className="text-right tabular-nums">{formatCurrency(x.montant)}</dd>
                </React.Fragment>
              ))}
              {totaux.timbre > 0 && <><dt className="text-muted-foreground">Droit de timbre</dt><dd className="text-right tabular-nums">{formatCurrency(totaux.timbre)}</dd></>}
              <dt className="font-semibold">Total TTC</dt><dd className="text-right font-semibold tabular-nums">{formatCurrency(totaux.totalTtc)}</dd>
              <dd className="col-span-2 mt-1 text-xs text-muted-foreground sm:col-span-4">{totaux.enLettres.charAt(0).toUpperCase() + totaux.enLettres.slice(1)}.</dd>
            </dl>
          ) : (
            <p className="mt-1 text-muted-foreground">{pret ? (chargement ? "Calcul en cours…" : "Aucun total : voir ci-dessous.") : "Les totaux apparaissent dès qu'un tiers et une ligne sont saisis."}</p>
          )}
          {bloquants.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-destructive">{bloquants.map((b) => <li key={b}>{b}</li>)}</ul>
          )}
          {/* ── L'aperçu AVANT IMPRESSION : le PDF tel qu'il sera imprimé, numéro prévu compris — rien n'est émis ni numéroté ── */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={voirImpression} disabled={!pret || rendu || bloquants.length > 0 || !!resultat}>
              <Eye className="h-4 w-4" aria-hidden />{rendu ? "Rendu…" : "Aperçu avant impression"}
            </Button>
            <span className="text-xs text-muted-foreground">Le PDF tel qu&apos;il sera imprimé, avec le numéro prévu — rien n&apos;est émis ni numéroté.</span>
          </div>
          {impressionErreur && <p className="mt-2 text-sm text-destructive" role="alert">{impressionErreur}</p>}
          {impression && (
            <div className="mt-3 space-y-2">
              <object data={impression.url} type="application/pdf" aria-label="Aperçu avant impression" className="h-[70vh] w-full rounded-md border border-border bg-card">
                <a className="underline" href={impression.url} target="_blank" rel="noreferrer">Ouvrir l&apos;aperçu dans un onglet</a>
              </object>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>Aperçu : {impression.pages} page{impression.pages > 1 ? "s" : ""} · numéro prévu {impression.numero} · rendu du serveur, le Word fait foi pour l&apos;impression officielle.</span>
                <span className="flex flex-wrap gap-x-4 gap-y-1">
                  <a className="py-1 underline" href={impression.url} target="_blank" rel="noreferrer">Ouvrir dans un onglet</a>
                  <button type="button" className="py-1 underline" onClick={() => setImpression(null)}>Fermer l&apos;aperçu</button>
                </span>
              </div>
            </div>
          )}
          {apercu && apercu.ok && apercu.avertissements.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">{apercu.avertissements.map((a) => <li key={a}>{a}</li>)}</ul>
          )}
        </section>

        {/* ── La numérotation, pour ceux qui tiennent la papeterie ── */}
        {props.peutReglerNumerotation && (
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer font-semibold">Numérotation des {PLURIEL_TYPE[type]} de cette société</summary>
            <p className="mt-1 text-xs text-muted-foreground">
              Jetons : <code>{"{n}"}</code> séquence, <code>{"{n:3}"}</code> sur 3 chiffres, <code>{"{aaaa}"}</code> / <code>{"{aa}"}</code> année, <code>{"{prefixe}"}</code>. Exemples : <code>{"{n:3}/FS/{aa}"}</code> → 001/FS/26 ; <code>{"{n:3}/DG/{aaaa}"}</code> → 012/DG/2026. Vide = <code>{"{prefixe}-{aaaa}-{n:4}"}</code>.
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_12rem_auto]">
              <Input aria-label="Motif de numérotation" value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="{n:3}/FS/{aa}" />
              <Input aria-label={`Premier numéro de ${champs.date.slice(0, 4)}`} inputMode="numeric" value={depart} onChange={(e) => setDepart(e.target.value)} placeholder={`Premier n° ${champs.date.slice(0, 4)} (ex. 32)`} />
              <Button type="button" variant="outline" onClick={enregistrerMotif} disabled={chargement}>Enregistrer</Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Le premier numéro est un plancher : 32 avec le motif {"{n:3}/DG/{aaaa}"} donne 032/DG/{champs.date.slice(0, 4)} pour la prochaine pièce, sans jamais reculer un compteur déjà plus loin.</p>
            {motifMessage && <p className="mt-1 text-xs text-muted-foreground">{motifMessage}</p>}
          </details>
        )}

        {/* ── Le résultat ── */}
        {resultat && (
          <section className={`rounded-lg border p-3 ${resultat.ok ? "border-success/50 bg-success/5" : "border-destructive/50 bg-destructive/5"}`} aria-live="polite">
            <p className="font-medium">{resultat.ok ? resultat.message : resultat.error}</p>
            {resultat.ok && (
              <>
                <div className="mt-2 flex flex-wrap gap-2">
                  {resultat.docxNodeId && <a className="rounded-md border border-border bg-card px-3 py-1.5 hover:bg-secondary" href={`/api/drive/${resultat.docxNodeId}/raw?dl=1`}>Télécharger le Word</a>}
                  {/* Le PDF s'ouvre sous la porte de la PIÈCE : le Drive personnel de l'émetteur répondait 403 aux autres lecteurs. */}
                  {resultat.pdfNodeId && <a className="rounded-md border border-border bg-card px-3 py-1.5 hover:bg-secondary" href={resultat.lienPdf ?? `/api/drive/${resultat.pdfNodeId}/raw`} target="_blank" rel="noreferrer">Ouvrir le PDF</a>}
                  {resultat.pdfNodeId && <a className="rounded-md border border-border bg-card px-3 py-1.5 hover:bg-secondary" href={resultat.lienPdf ? `${resultat.lienPdf}&dl=1` : `/api/drive/${resultat.pdfNodeId}/raw?dl=1`}>Télécharger le PDF</a>}
                  {resultat.legalDocumentId && <a className="rounded-md border border-border bg-card px-3 py-1.5 hover:bg-secondary" href={`/api/legal/${encodeURIComponent(resultat.legalDocumentId)}/fichier?format=xlsx&dl=1`}>Générer sur Excel</a>}
                  {resultat.legalDocumentId && resultat.lien !== null && <a className="rounded-md border border-border bg-card px-3 py-1.5 hover:bg-secondary" href={`/legal/${resultat.legalDocumentId}`}>Fiche au registre</a>}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {resultat.pdfNodeId
                    ? resultat.pdfMethode === "editeur" ? "PDF imprimé par l'éditeur Office du serveur." : "PDF rendu par le serveur : le Word fait foi pour l'impression officielle."
                    : "Aucun PDF n'a pu être produit : le Word fait foi."}
                  {resultat.surPapierEnTete ? " Sur le papier en-tête de la société." : " Sans papier en-tête (mise en page neutre)."}
                </p>
                {resultat.avertissements && resultat.avertissements.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">{resultat.avertissements.map((a) => <li key={a}>{a}</li>)}</ul>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </Sheet>
  );
}
