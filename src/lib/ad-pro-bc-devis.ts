import { Prisma, type AdProItemKind } from "@prisma/client";
import { texteDeLaLecture } from "@/lib/pieces-lues/lecture-fichier";
import { identiteEmetteurDuTexte, identiteUtilisable } from "@/lib/pieces-lues/emetteur";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import {
  apercuPourEcran, emettreDocumentDrive, previsualiserDocument, previsualiserRevision, reviserDocumentDrive,
  type ApercuDocument, type ApercuPiece, type DemandeDocument, type ModificationsDocument,
} from "@/platform/in-process/artifact/factory";
import { valeursDeLaSpec, type ValeursComposables } from "@/lib/legal/piece-emise";
import { calculerTotaux, type LigneCommerciale, type PartieCommerciale } from "@/lib/artifact/factory/commercial";
import {
  appliquerCorrections, brouillonPerime, correctionsDuBrouillon, lignesEffectives, type BrouillonBc,
} from "@/lib/bons-de-commande/brouillon";
import { devisDesPostes, type DevisDePosteVue } from "@/lib/queries/ad-pro-devis-poste";
import { rattacherPieceAuPoste } from "@/lib/ad-pro/pieces-poste";
import { lignesDuBon, plafondDesDevis, refusDepassement, refusMontantDesDevis, totalValideDesDevis, type LigneDevisPoste } from "@/lib/ad-pro/devis-poste";
import { formatDzd } from "@/lib/promo-material/devis";
import { ITEM_KIND_LABELS } from "@/lib/ad-pro-items";
import { enSerie } from "@/lib/refs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * GÉNÉRER LES BONS DE COMMANDE D'UN POSTE D'APRÈS LES LIGNES VALIDÉES DE SES DEVIS (§118.206).
 *
 * « Il se peut qu'il y ait eu plusieurs devis, et différentes références dans chaque devis qui soient
 * validées : alors ça peut demander de générer UN BC PAR DEVIS (incluant UNIQUEMENT les références
 * validées). S'il oublie une référence, il peut juste la cocher dans le devis et RÉGÉNÉRER le BC. »
 *
 * Ce n'est PAS un second générateur (§118.5) : la composition, la numérotation, le Word et le PDF, la
 * révision (même numéro, version suivante, historique) sont ceux de la FABRIQUE de pièces commerciales,
 * la même que le matériel promotionnel et les Finances. Ce module ne fait que traduire — lignes validées
 * d'un devis → demande de la fabrique — et tenir le LIEN entre les lignes et le BC qui les porte
 * (`AdProDevisLigne.bcId`), pour que « régénérer » sache ce qui a changé.
 *
 * ── CE QUE LE BC PORTE, ET D'OÙ IL TIENT SA PORTE ───────────────────────────────────────────
 *
 *   • UNIQUEMENT les lignes validées POUR CE POSTE, de CE devis : une ligne non cochée n'est jamais
 *     commandée, une ligne validée pour un autre poste non plus.
 *   • Il découle de son devis (`chainFromId`), est rattaché au poste (`AdProItemPiece`) et naît avec le
 *     poste pour SOURCE : sa porte est le visa du POSTE (`portesDesBC`, source « POSTE ») — le centre
 *     Ad & Pro vise la demande, au-dessus du seuil, une fois ; la pièce n'a pas une seconde porte.
 *   • Il est composé sous DÉLÉGATION de la demande (le demandeur n'engage pas la société à titre
 *     personnel), au nom de la société DE LA DEMANDE — jamais de celle de qui clique.
 *
 * Hors d'un fichier « use server » : l'auteur est un argument, ce n'est pas une action d'écran
 * (§118.153). L'appelant a vérifié QUI peut générer, et l'état du poste ; ce module relit les devis dans
 * l'appelant (sous la file du poste) et refuse ce qui ne se compose pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PosteAGenerer {
  item: { id: string; label: string; kind: AdProItemKind; supplier: string | null; amountGranted: number | null };
  /** La référence de l'opération (« SPO-2026-014 ») ou le nom du congrès. */
  ref: string;
  /** La société DE LA DEMANDE — celle qui commande. */
  societe: string;
}

export interface BCGenere {
  pieceId: string;
  devisPieceId: string;
  reference: string;
  version: number;
  totalTtc: number;
  /** Vrai quand le BC existait et vient d'être RÉVISÉ (même numéro, version suivante). */
  regenere: boolean;
  /** La réserve qui accompagne un BC pas encore validé (« attend le centre… »). */
  reserve: string | null;
}

export interface BilanGeneration {
  bcs: BCGenere[];
  echecs: string[];
}

/** Le fournisseur tel que le BC l'imprime : la fiche de l'annuaire quand le devis la désigne, sinon le nom seul. */
export async function tiersDuDevis(
  d: Pick<DevisDePosteVue, "fournisseurId" | "fournisseur" | "fournisseurLu" | "pieceId"> & { entete: { lectureId: string | null } },
  itemSupplier: string | null,
) {
  if (d.fournisseurId) {
    const f = await prisma.companyContact.findUnique({
      where: { id: d.fournisseurId },
      select: { name: true, address: true, city: true, wilaya: true, rc: true, nif: true, rib: true, phone: true, email: true },
    });
    if (f) {
      const adresse = [f.address, [f.city, f.wilaya].filter(Boolean).join(", ")].filter((x) => x && x.trim()).join("\n") || null;
      return { ok: true as const, tiers: { nom: f.name, adresse, rc: f.rc, nif: f.nif, rib: f.rib, telephone: f.phone, email: f.email }, annuaire: true };
    }
  }
  // SANS FICHE D'ANNUAIRE : l'identité RECOPIÉE DU DEVIS (raison sociale, adresse, NIF, RC, RIB…) — c'est ce que le
  // fournisseur a imprimé, et c'est ce que le bon de commande doit porter (Direction, 06/10).
  let lu = d.fournisseurLu;
  // UN DEVIS LU AVANT CETTE ÉVOLUTION n'a pas gardé l'identité : on la RECOPIE du texte déjà lu (sans relire le fichier,
  // sans toucher aux lignes validées), et on la garde pour les fois suivantes.
  if (!lu?.nom && d.entete.lectureId) {
    const texte = await texteDeLaLecture(d.entete.lectureId).catch(() => null);
    const recopiee = texte ? identiteEmetteurDuTexte(texte) : null;
    if (identiteUtilisable(recopiee)) {
      lu = recopiee;
      await prisma.adProDevis.updateMany({
        where: { legalDocumentId: d.pieceId },
        data: { fournisseurLu: recopiee as unknown as Prisma.InputJsonValue },
      }).catch(() => undefined);
      await prisma.legalDocument.updateMany({
        where: { id: d.pieceId, OR: [{ counterparty: null }, { counterparty: "" }] },
        data: { counterparty: recopiee.nom },
      }).catch(() => undefined);
    }
  }
  if (lu?.nom) {
    return {
      ok: true as const,
      tiers: { nom: lu.nom, adresse: lu.adresse, rc: lu.rc, nif: lu.nif, rib: lu.rib, telephone: lu.telephone, email: lu.email },
      annuaire: false,
    };
  }
  const nom = d.fournisseur?.trim() || itemSupplier?.trim() || "";
  if (!nom) {
    return { ok: false as const, error: "Le fournisseur de ce devis n'est pas nommé : renseignez-le sur le devis (il donne son nom, son adresse, son RC et son NIF au bon de commande)." };
  }
  return { ok: true as const, tiers: { nom }, annuaire: false };
}

/** Les lignes de la vue, dans la forme que lit le module pur : seule la validation POUR CE POSTE compte pour composer le BC. */
function lignesPures(d: DevisDePosteVue, itemId: string): LigneDevisPoste[] {
  return d.lignes.map((l) => ({
    id: l.id, position: l.position, reference: l.reference, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice,
    lue: l.lue, aVerifier: l.aVerifier, validatedItemId: l.validee ? itemId : null, bcId: null,
  }));
}

/** Les lignes du BC d'un devis POUR UN POSTE — la lecture que la carte, la génération et le contrôle du montant partagent. */
export function lignesDuBCDuDevis(d: DevisDePosteVue, itemId: string) {
  return lignesDuBon(d.entete, lignesPures(d, itemId), itemId);
}

/**
 * Le montant TTC que les lignes validées des devis QUI COMPTENT totalisent — pour le plafond du montant accordé. Une copie
 * de la même pièce, ou une proposition écartée d'un voyageur, n'y entre pas (`devisMisAPart`).
 */
export function totalValideDuPoste(devis: readonly DevisDePosteVue[]): number {
  return totalValideDesDevis(devis).ttc;
}

/** Le refus de dépassement, lu par l'action ET par la carte (`refusMontantDesDevis`, le même calcul). */
export function refusMontantDuPoste(devis: readonly DevisDePosteVue[], accorde: number | null): string | null {
  return refusMontantDesDevis(devis, accorde);
}

/**
 * ÉCRIRE LE LIEN LIGNES ↔ BC. Les lignes validées pour ce poste dans ce devis sont couvertes par ce BC ; celles que
 * ce BC portait et qui ne sont plus validées pour ce poste ne le sont plus. Deux écritures conditionnelles : une ligne
 * revalidée ou retirée entre-temps par un autre geste n'est jamais recouverte (§118.187).
 */
async function lierLesLignes(devisPieceId: string, itemId: string, bcId: string): Promise<void> {
  await prisma.adProDevisLigne.updateMany({
    where: { devis: { legalDocumentId: devisPieceId }, validatedItemId: itemId, OR: [{ bcId: null }, { bcId: { not: bcId } }] },
    data: { bcId },
  });
  await prisma.adProDevisLigne.updateMany({
    where: { devis: { legalDocumentId: devisPieceId }, bcId, OR: [{ validatedItemId: null }, { validatedItemId: { not: itemId } }] },
    data: { bcId: null },
  });
}

/** L'objet que le BC porte quand le demandeur n'en a pas écrit : « Sponsoring : Traiteur — SPO-2026-006 ». */
export const objetParDefaut = (poste: PosteAGenerer): string => `${ITEM_KIND_LABELS[poste.item.kind]} : ${poste.item.label} — ${poste.ref}`;

/**
 * Ce que le brouillon corrige d'une pièce DÉJÀ émise (révision d'un BC à régénérer) : TOUT ce que le composeur a écrit
 * (`correctionsDuBrouillon`) — la même forme que `ModificationsDocument`, que le compilateur vérifie ici.
 */
export function modificationsDuBrouillon(b: BrouillonBc): ModificationsDocument {
  const m: ModificationsDocument = correctionsDuBrouillon(b);
  return m;
}

/**
 * LA DEMANDE DE LA FABRIQUE POUR LE BC D'UN DEVIS — la MÊME pour l'aperçu et pour l'émission (§118.5) : deux compositions
 * finiraient par diverger sur un champ. Le brouillon, quand il y en a un, remplace ce que le devis donne.
 */
export function demandeDuBC(
  poste: PosteAGenerer,
  d: Pick<DevisDePosteVue, "reference" | "pieceId" | "entete">,
  tiers: PartieCommerciale,
  lignes: LigneCommerciale[],
  brouillon: BrouillonBc | null,
): DemandeDocument {
  const taxes = d.entete.extraTaxRate ? [{ libelle: d.entete.extraTaxLabel ?? "Taxe additionnelle", taux: d.entete.extraTaxRate / 100 }] : null;
  const duDevis: DemandeDocument = {
    type: "BON_DE_COMMANDE",
    societe: poste.societe,
    tiers,
    lignes,
    // La TVA est celle du PAPIER : `genererBonDeCommandePoste` refuse un devis dont le taux n'existe pas, avant d'arriver ici.
    tvaDefaut: (d.entete.tvaRate ?? 0) / 100,
    taxes,
    referenceAmont: d.reference,
    referenceAmontDate: d.entete.quoteDate,
    objet: objetParDefaut(poste),
    chainFromId: d.pieceId,
    dossier: `Ad & Pro/${poste.ref}`,
  };
  // LE BROUILLON L'EMPORTE, champ par champ (Direction, 14/10/2026 : « chaque détail peut être modifié dans le BC ») : ce que le
  // demandeur a corrigé dans le composeur — fournisseur, dates, paiement, TVA, remises, taxes, livraison, contact, papier,
  // émetteur, signataire, mentions — est ce que le BC émis imprime.
  const corrigee = brouillon ? appliquerCorrections(duDevis, correctionsDuBrouillon(brouillon)) : duDevis;
  return { ...corrigee, ...(brouillon?.numeroChoisi ? { numeroChoisi: brouillon.numeroChoisi } : {}) };
}

/**
 * LES TOTAUX DU BC QU'UN BROUILLON FERAIT ÉMETTRE — la MÊME arithmétique que la fabrique (`calculerTotaux`) sur la MÊME
 * demande (`demandeDuBC`) : remises de ligne, TVA par ligne, remise globale, taxes, timbre. Le fournisseur n'y entre pas.
 */
export function totauxDuBrouillon(poste: PosteAGenerer, d: DevisDePosteVue, brouillon: BrouillonBc): { ht: number; ttc: number } {
  const lignes = lignesEffectives(brouillon, lignesDuBCDuDevis(d, poste.item.id));
  const dem = demandeDuBC(poste, d, { nom: "" }, lignes, brouillon);
  const t = calculerTotaux({ lignes: dem.lignes, tvaDefaut: dem.tvaDefaut, remiseGlobale: dem.remiseGlobale, taxes: dem.taxes, modePaiement: dem.modePaiement });
  return { ht: t.totalHt, ttc: t.totalTtc };
}

/**
 * LE PLAFOND DE L'ACCORDÉ, LE MÊME PARTOUT (audit M-03) — génération, correction de l'aperçu, validation : le TTC des devis qui
 * comptent, où chaque devis qui a un brouillon pèse ce que son BC corrigé pèserait (`totauxDuBrouillon`). `brouillon` : celui
 * qu'on s'apprête à écrire, à la place de celui en base ; `totaux` : le TTC d'un BC révisé (« Modifier le BC »), à la place des
 * lignes de son devis. `null` : sous l'accordé.
 */
export function refusPlafondDuPoste(
  poste: PosteAGenerer, devis: readonly DevisDePosteVue[], accorde: number | null,
  opts: { brouillon?: { pieceId: string; brouillon: BrouillonBc }; totaux?: ReadonlyMap<string, { ht: number; ttc: number }> } = {},
): string | null {
  const corriges = new Map<string, { ht: number; ttc: number }>();
  for (const d of devis) {
    if (d.annule || (d.etat !== "A_GENERER" && d.etat !== "A_REGENERER")) continue;
    const b = opts.brouillon && opts.brouillon.pieceId === d.pieceId ? opts.brouillon.brouillon : d.brouillon;
    if (b) corriges.set(d.pieceId, totauxDuBrouillon(poste, d, b));
  }
  for (const [pieceId, t] of opts.totaux ?? []) corriges.set(pieceId, t);
  const p = plafondDesDevis(devis, corriges);
  return refusDepassement(p.ttc, accorde, p.ht, p.tvaIndiquee);
}

export interface ApercuDuBC {
  ok: true;
  pdfBase64: string | null;
  pages: number;
  /** Le numéro que la validation attribuerait si elle avait lieu maintenant — prévu, JAMAIS réservé. */
  numeroPrevu: string;
  /** La société qui commande — celle dont le registre NNN/DG/AAAA vérifie un numéro choisi. */
  societeId: string;
  /** Le numéro vient du registre commun de la société : il peut être choisi à la validation. */
  surRegistre: boolean;
  /** Le BC existe déjà (révision) : sa référence, inchangée. */
  referenceExistante: string | null;
  /** Le BC existant (à régénérer) — son numéro se modifie dans l'aperçu, la pièce exclue de l'unicité. */
  bcExistantId: string | null;
  /** Le numéro modifié gardé sur le brouillon d'un BC à régénérer (Direction, 14/10/2026), sinon `null`. */
  numeroModifie: string | null;
  totaux: { totalHt: number; totalTva: number; totalTaxes: number; totalTtc: number; enLettres: string } | null;
  bloquants: string[];
  avertissements: string[];
  /** Le fournisseur tel que le BC l'imprimera. */
  tiers: PartieCommerciale;
  /** LE COMPOSEUR PRÉ-REMPLI : la pièce telle que la fabrique la composerait (devis + corrections du brouillon), en valeurs d'écran. */
  valeurs: ValeursComposables;
  /** Les totaux et ce que la fabrique dit, dans la forme que lit le composeur. */
  ecran: ApercuPiece;
  /** Le numéro choisi gardé sur le brouillon (registre NNN/DG/AAAA), sinon `null`. */
  numeroChoisi: string | null;
}

/**
 * L'APERÇU DU BC D'UN DEVIS, COMPOSÉ À BLANC — aucun numéro consommé, aucune ligne au registre, aucun fichier au Drive. Sous la
 * délégation du poste : le demandeur relit son BC sans droit d'écriture Legal. Un devis dont le BC existe déjà (« à régénérer »)
 * se prévisualise comme la RÉVISION qui suivra (`previsualiserRevision`) : ce que le composeur montre est le BC existant, ses
 * modifications comprises, avec les lignes nouvelles — pas une pièce recomposée du devis qui écraserait ce qu'on y a changé.
 */
export async function composerApercuDuBC(
  user: CurrentUser, poste: PosteAGenerer, d: DevisDePosteVue, brouillon: BrouillonBc, opts: { avecPdf?: boolean } = {},
): Promise<{ ok: true; r: ApercuDocument; letterheadId: string; tiers: PartieCommerciale } | { ok: false; error: string }> {
  const lignesDevis = lignesDuBCDuDevis(d, poste.item.id);
  if (lignesDevis.length === 0 && !d.bc) return { ok: false, error: "Aucune ligne n'est validée pour ce devis." };
  if (brouillonPerime(brouillon, lignesDevis)) {
    return { ok: false, error: "Les lignes validées du devis ont changé depuis les corrections : retirez cet aperçu et générez-le de nouveau." };
  }
  const lignes = lignesEffectives(brouillon, lignesDevis);
  const corrections = correctionsDuBrouillon(brouillon);
  const nom = d.reference?.trim() || d.titre;
  const delegation = `${poste.ref} — poste « ${poste.item.label} » : aperçu du bon de commande du devis « ${nom} », relu par le demandeur`;
  if (d.bc) {
    const r = await previsualiserRevision(user, { legalDocumentId: d.bc.id, modifications: { lignes, ...corrections }, avecPdf: opts.avecPdf }, { delegation });
    if (!r.ok) return { ok: false, error: r.motif };
    return { ok: true, r, letterheadId: corrections.letterheadId ?? r.papierEnTete?.id ?? "", tiers: r.spec.tiers };
  }
  const t = await tiersDuDevis(d, poste.item.supplier);
  if (!t.ok && !corrections.tiers?.nom) return { ok: false, error: t.error };
  const demande = demandeDuBC(poste, d, t.ok ? t.tiers : { nom: "" }, lignes, brouillon);
  const r = await previsualiserDocument(user, demande, { avecPdf: opts.avecPdf, delegation, numeroAffiche: "À attribuer à la validation" });
  if (!r.ok) return { ok: false, error: r.motif };
  return { ok: true, r, letterheadId: demande.letterheadId ?? "", tiers: demande.tiers };
}

/**
 * L'APERÇU DU BC À L'OUVERTURE — le PDF tel qu'il sera imprimé (numéro « À attribuer à la validation »), et le composeur
 * pré-rempli de ce que le BC portera : le demandeur relit et corrige « chaque détail » avant de valider.
 */
export async function apercuDuBC(
  user: CurrentUser, poste: PosteAGenerer, d: DevisDePosteVue, brouillon: BrouillonBc,
): Promise<ApercuDuBC | { ok: false; error: string }> {
  const c = await composerApercuDuBC(user, poste, d, brouillon, { avecPdf: true });
  if (!c.ok) return c;
  const { r } = c;
  return {
    ok: true,
    pdfBase64: r.pdf ? r.pdf.octets.toString("base64") : null,
    pages: r.pdf?.pages ?? 0,
    numeroPrevu: r.numeroProchain,
    societeId: r.societe.id,
    surRegistre: r.surRegistre,
    referenceExistante: d.bc ? d.bc.reference : null,
    bcExistantId: d.bc ? d.bc.id : null,
    numeroModifie: d.bc ? correctionsDuBrouillon(brouillon).numero ?? null : null,
    totaux: r.totaux ? { totalHt: r.totaux.totalHt, totalTva: r.totaux.totalTva, totalTaxes: r.totaux.totalTaxes, totalTtc: r.totaux.totalTtc, enLettres: r.totaux.enLettres } : null,
    bloquants: r.bloquants.length > 0 ? r.bloquants : (r.pdf ? [] : r.pdfErreur ? [r.pdfErreur] : []),
    avertissements: r.avertissements,
    tiers: c.tiers,
    valeurs: valeursDeLaSpec(r.spec, c.letterheadId || null),
    ecran: apercuPourEcran(r, Boolean(d.bc)),
    numeroChoisi: brouillon.numeroChoisi,
  };
}

/**
 * GÉNÈRE (ou RÉVISE) le bon de commande de chaque devis demandé. Chaque devis passe par SA file (un geste à la fois
 * sur ses lignes) et est RELU dans la file : ce que la carte avait vu a pu changer — une ligne décochée, un BC annulé
 * entre-temps. Un devis dont l'état n'est plus ni « à générer » ni « à régénérer » n'est PAS touché et ne fait pas
 * d'erreur : il est écarté, et le bilan ne le compte pas. Chaque devis est isolé : l'échec de l'un est dit sans empêcher
 * les autres.
 */
export async function genererLesBCsDuPoste(
  user: CurrentUser, poste: PosteAGenerer, pieceIds: readonly string[],
  /** Les brouillons VALIDÉS par le demandeur, par devis : leurs corrections remplacent ce que le devis donne. */
  brouillons: ReadonlyMap<string, BrouillonBc> = new Map(),
): Promise<BilanGeneration> {
  const bilan: BilanGeneration = { bcs: [], echecs: [] };
  for (const pieceId of pieceIds) {
    await enSerie(`ad-pro-devis:${pieceId}`, async () => {
      const d = ((await devisDesPostes([poste.item.id])).get(poste.item.id) ?? []).find((x) => x.pieceId === pieceId && !x.annule);
      if (!d) { bilan.echecs.push("un devis n'est plus rattaché à ce poste"); return; }
      const nom = d.reference?.trim() || d.titre;
      const lignesDevis = lignesDuBCDuDevis(d, poste.item.id);
      if (d.etat !== "A_GENERER" && d.etat !== "A_REGENERER") {
        if (d.refus) bilan.echecs.push(`${nom} : ${d.refus}`);
        return;
      }
      if (lignesDevis.length === 0) { bilan.echecs.push(`${nom} : aucune ligne validée`); return; }
      const brouillon = brouillons.get(pieceId) ?? null;
      if (brouillon && brouillonPerime(brouillon, lignesDevis)) {
        bilan.echecs.push(`${nom} : les lignes validées du devis ont changé depuis l'aperçu — régénérez l'aperçu avant de valider`);
        return;
      }
      const lignes = lignesEffectives(brouillon, lignesDevis);
      const delegation = `${poste.ref} — poste « ${poste.item.label} » validé et son bon de commande demandé, composé d'après les lignes validées du devis « ${nom} »${brouillon ? ", aperçu validé par le demandeur" : ""}`;
      if (d.etat === "A_REGENERER" && d.bc) {
        const r = await reviserDocumentDrive(user, {
          legalDocumentId: d.bc.id,
          modifications: { lignes, ...(brouillon ? modificationsDuBrouillon(brouillon) : {}) },
          motif: `Lignes validées du devis modifiées (${d.nbAjoutees} ajoutée${d.nbAjoutees > 1 ? "s" : ""}, ${d.nbRetirees} retirée${d.nbRetirees > 1 ? "s" : ""}).`,
        }, { delegation });
        if (!r.ok) { bilan.echecs.push(`${nom} : ${r.motif}`); return; }
        await lierLesLignes(d.pieceId, poste.item.id, d.bc.id);
        bilan.bcs.push({ pieceId: d.bc.id, devisPieceId: d.pieceId, reference: r.reference, version: r.version, totalTtc: r.totaux.totalTtc, regenere: true, reserve: r.reserveBonDeCommande ?? null });
        return;
      }
      const t = await tiersDuDevis(d, poste.item.supplier);
      // Un fournisseur que le demandeur a NOMMÉ dans l'aperçu suffit, même quand le devis ne le nommait pas.
      if (!t.ok && !(brouillon && correctionsDuBrouillon(brouillon).tiers?.nom)) { bilan.echecs.push(`${nom} : ${t.error}`); return; }
      const r = await emettreDocumentDrive(user, demandeDuBC(poste, d, t.ok ? t.tiers : { nom: "" }, lignes, brouillon), { source: { type: "AD_PRO_ITEM", id: poste.item.id }, delegation });
      if (!r.ok) { bilan.echecs.push(`${nom} : ${r.motif}`); return; }
      await rattacherPieceAuPoste({ itemId: poste.item.id, legalDocumentId: r.legalDocumentId, nature: "BON_DE_COMMANDE", acteurId: user.id });
      await lierLesLignes(d.pieceId, poste.item.id, r.legalDocumentId);
      bilan.bcs.push({
        pieceId: r.legalDocumentId, devisPieceId: d.pieceId, reference: r.reference, version: r.version, totalTtc: r.totaux.totalTtc, regenere: false,
        reserve: r.reserveBonDeCommande ?? null,
      });
    });
  }
  return bilan;
}

/** La phrase du bilan — une rédaction pour l'action (et pour Adam le jour où il l'ouvrira). */
export function phraseBilanGeneration(b: BilanGeneration): string {
  const faits = b.bcs.map((x) => `${x.reference}${x.regenere ? ` (révisé, version ${x.version})` : ""} — ${formatDzd(x.totalTtc)} TTC`);
  const reserves = [...new Set(b.bcs.map((x) => x.reserve).filter((x): x is string => Boolean(x)))];
  return `${b.bcs.length} bon${b.bcs.length > 1 ? "s" : ""} de commande ${b.bcs.every((x) => x.regenere) ? "mis à jour" : "généré" + (b.bcs.length > 1 ? "s" : "")} : ${faits.join(" ; ")}.`
    + (b.echecs.length ? ` Non générés : ${b.echecs.join(" ; ")}.` : "")
    + (reserves.length ? ` ${reserves.join(" ")}` : "");
}
