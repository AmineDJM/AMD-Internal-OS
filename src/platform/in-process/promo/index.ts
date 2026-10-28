import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { peutOuvrirLeDossierPromo, devisDuDossier, devisLu } from "@/lib/queries/promo-circuit";
import { type ExecutionDevis, type FactureLue } from "@/lib/queries/promo-execution";
import { libelleEtape, type PromoState } from "@/lib/promo-material/circuit";
import { totauxDeLaSelection, type DevisLu } from "@/lib/promo-material/devis";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PORT DU MATÉRIEL PROMOTIONNEL (circuit 2, §118.152) — ce par quoi Adam DÉSIGNE un dossier,
 * un devis, une ligne, un bon de commande ou une facture, et atteint les gestes de l'écran.
 *
 * ── POURQUOI UN PORT, ET PAS DES IMPORTS DIRECTS ─────────────────────────────────────────
 * Les ops d'Adam vivent côté Adam : chaque import direct de `prisma`, d'une requête ou d'une
 * action de l'ERP y serait un franchissement de plus, et le cliquet de frontière est à marge zéro
 * (§118.114). Ce module est le pont : il lit la base et RÉEXPORTE les actions, sans y ajouter de
 * règle — les droits vivent dans les actions (qui revérifient tout) et dans la porte de la fiche.
 *
 * ── LA DÉSIGNATION PASSE PAR LA PORTE DE LA FICHE, PAS PAR LA TABLE ──────────────────────
 * Les deux résolveurs d'avant (`resolvePromo`, `resolvePromoDossier`) cherchaient dans la table
 * sans regarder qui demandait : une désignation ambiguë rendait, en candidats, la référence et le
 * TITRE de dossiers que la personne n'a pas le droit d'ouvrir — la fuite exacte que §118.150(d) a
 * fermée pour les contrats de consulting. Ici, un candidat n'existe que s'il passe
 * `peutOuvrirLeDossierPromo` — la règle de la fiche, lue telle quelle (§118.5) : les parties
 * prenantes du dossier, le secrétariat, le pharmacien qui instruit son visa, la vue globale.
 *
 * ── LA LECTURE BORNÉE LE DIT ─────────────────────────────────────────────────────────────
 * Les candidats se lisent par ressemblance (référence, titre) puis passent la porte un par un. Une
 * lecture bornée qui filtre ENSUITE pourrait couper un dossier visible au-delà de la borne et
 * répondre « aucun » — une troncature silencieuse (§118.60, §118.149d). Au-delà de la borne, on ne
 * conclut pas : on demande la référence exacte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export {
  demanderDevisPromo, supprimerDevisPromo, terminerRetranscriptionPromo, choisirLignesPromo, demanderCorrectionDevisPromo,
} from "@/lib/actions/promo-devis-actions";
export {
  genererBonsDeCommandePromo, modifierBonDeCommandePromo, annulerBonDeCommandePromo, marquerBonDeCommandeEnvoye,
  deposerFacturePromo, demanderPaiementFacturePromo, adresserInfoMedicaleFacturePromo,
} from "@/lib/actions/promo-execution-actions";
export { executionDuDossier, type ExecutionDevis, type FactureLue } from "@/lib/queries/promo-execution";
export { totauxDeLaSelection, totauxRetenus, totalLigneHT, formatDzd, type DevisLu, type LigneDevisLue } from "@/lib/promo-material/devis";
// L'ÉTAPE EN CLAIR, dans le vocabulaire de SON circuit — la même phrase que la fiche et la liste.
export { libelleEtape } from "@/lib/promo-material/circuit";
// LES ACHATS (§118.165) : la règle qui dit ce qu'une facture sans détail reprend du BC, et ce qu'un
// dossier a demandé — lues par les cartes d'Adam pour ne pas offrir un geste que l'action refuserait.
export { lignesProposees, totauxFacture } from "@/lib/promo-material/achats";
export { articlesDemandesDuDossier } from "@/lib/queries/promo-achats";

const BORNE = 100;

const plier = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export interface DossierPromoDesigne {
  id: string;
  reference: string;
  title: string;
  circuitState: string | null;
  circuitVersion: number;
  /** L'étape en clair, dans le vocabulaire de SON circuit (un dossier d'avant garde le sien). */
  etape: string | null;
}

/**
 * DÉSIGNER UN DOSSIER — référence exacte d'abord, sinon référence ou titre qui contient le texte ;
 * UN seul dossier ouvert à la personne, ou un refus qui ne nomme que ceux qu'elle peut ouvrir.
 */
export async function designerDossierPromo(user: SessionUser, brut: string): Promise<DossierPromoDesigne | { error: string }> {
  const q = brut.trim();
  if (!q) return { error: "Précisez le dossier de matériel promotionnel (champ « reference » — MP-AAAA-NNN ou titre)." };
  const select = {
    id: true, reference: true, title: true, circuitState: true, circuitVersion: true,
    requesterId: true, assistantId: true, requestValidatorId: true, marketingValidatorId: true, companyId: true,
  } as const;
  const exacts = await prisma.promoMaterial.findMany({ where: { reference: { equals: q, mode: "insensitive" } }, select, take: 2 });
  const lus = exacts.length > 0
    ? exacts
    : await prisma.promoMaterial.findMany({
        where: { OR: [{ reference: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
        select, orderBy: { createdAt: "desc" }, take: BORNE + 1,
      });
  if (lus.length > BORNE) return { error: `Plus de ${BORNE} dossiers correspondent à « ${q} » : donnez la référence exacte (MP-AAAA-NNN).` };
  const ouverts: typeof lus = [];
  for (const r of lus) if (await peutOuvrirLeDossierPromo(user, r)) ouverts.push(r);
  if (ouverts.length === 0) return { error: `Aucun dossier de matériel promotionnel « ${q} » parmi ceux qui vous sont ouverts.` };
  let choisi = ouverts.length === 1 ? ouverts[0] : null;
  if (!choisi) {
    const titres = ouverts.filter((r) => plier(r.title) === plier(q));
    if (titres.length === 1) choisi = titres[0];
  }
  if (!choisi) {
    return { error: `Plusieurs dossiers correspondent à « ${q} » : ${ouverts.slice(0, 8).map((r) => `${r.reference} — ${r.title}`).join(" ; ")} — donnez la référence exacte.` };
  }
  const version = choisi.circuitVersion === 2 ? 2 : 1;
  return {
    id: choisi.id, reference: choisi.reference, title: choisi.title,
    circuitState: choisi.circuitState, circuitVersion: version,
    etape: choisi.circuitState ? libelleEtape(choisi.circuitState as PromoState, version) : null,
  };
}

/** Les devis du dossier, lus (lignes comprises) — la même lecture que la fiche. */
export async function devisLusDuDossier(promoId: string): Promise<DevisLu[]> {
  return (await devisDuDossier(promoId)).map(devisLu);
}

/**
 * DÉSIGNER UN DEVIS DU DOSSIER — par son fournisseur ou sa référence. Le dossier est déjà ouvert à
 * la personne : nommer ses fournisseurs dans un refus ne révèle rien qu'elle ne voit pas.
 */
export function designerDevis<T extends { supplierName?: string; fournisseur?: string; reference: string | null }>(
  devis: readonly T[], brut: string,
): T | { error: string } {
  const q = plier(brut);
  const nom = (d: T) => d.supplierName ?? d.fournisseur ?? "";
  if (!q) return { error: `Précisez le devis (fournisseur ou référence) : ${devis.map((d) => nom(d)).join(", ") || "aucun devis sur ce dossier"}.` };
  const exacts = devis.filter((d) => plier(nom(d)) === q || (d.reference && plier(d.reference) === q));
  const trouves = exacts.length ? exacts : devis.filter((d) => plier(nom(d)).includes(q) || (d.reference && plier(d.reference).includes(q)));
  if (trouves.length === 1) return trouves[0];
  if (trouves.length === 0) return { error: `Aucun devis « ${brut} » sur ce dossier. Devis présents : ${devis.map((d) => nom(d)).join(", ") || "aucun"}.` };
  return { error: `Plusieurs devis correspondent à « ${brut} » : ${trouves.map((d) => `${nom(d)}${d.reference ? ` (${d.reference})` : ""}`).join(" ; ")} — précisez.` };
}

/**
 * LES LIGNES QU'UNE PHRASE RETIENT — « tout le devis Atlas et la ligne Kakémono de Stands Sahel ».
 *
 * Deux façons de désigner, cumulables : un FOURNISSEUR retient toutes les lignes de son devis ; une
 * LIGNE se désigne par sa référence, et « Fournisseur : ligne » lève l'ambiguïté quand deux devis
 * portent la même. Une ligne ambiguë n'est JAMAIS tranchée ici : retenir la mauvaise, c'est la
 * commander (§104.7).
 */
export function lignesDesignees(devis: readonly DevisLu[], fournisseurs: readonly string[], lignes: readonly string[]): { ids: string[] } | { error: string } {
  const ids = new Set<string>();
  for (const f of fournisseurs) {
    const d = designerDevis(devis, f);
    if ("error" in d) return d;
    for (const l of d.lines) ids.add(l.id);
  }
  for (const brut of lignes) {
    const [avant, apres] = brut.includes(":") ? [brut.slice(0, brut.indexOf(":")), brut.slice(brut.indexOf(":") + 1)] : [null, brut];
    let perimetre: readonly DevisLu[] = devis;
    if (avant !== null && avant.trim()) {
      const d = designerDevis(devis, avant);
      if ("error" in d) return d;
      perimetre = [d];
    }
    const q = plier(apres);
    if (!q) return { error: `Ligne vide dans « ${brut} ».` };
    const toutes = perimetre.flatMap((d) => d.lines.map((l) => ({ d, l })));
    const exactes = toutes.filter(({ l }) => plier(l.reference) === q);
    const trouvees = exactes.length ? exactes : toutes.filter(({ l }) => plier(l.reference).includes(q));
    if (trouvees.length === 0) return { error: `Aucune ligne « ${apres.trim()} »${avant ? ` dans le devis « ${avant.trim()} »` : ""} sur ce dossier.` };
    if (trouvees.length > 1) {
      return { error: `Plusieurs lignes correspondent à « ${apres.trim()} » : ${trouvees.slice(0, 8).map(({ d, l }) => `${d.supplierName} : ${l.reference}`).join(" ; ")} — écrivez « Fournisseur : ligne ».` };
    }
    ids.add(trouvees[0].l.id);
  }
  return { ids: [...ids] };
}

/** Les totaux d'une sélection SIMULÉE — la carte montre ce que le clic fixera, avant le clic. */
export function totauxSiRetenues(devis: readonly DevisLu[], ids: readonly string[]) {
  const garde = new Set(ids);
  return totauxDeLaSelection(devis.map((d) => ({ ...d, lines: d.lines.map((l) => ({ ...l, selected: garde.has(l.id) })) })));
}

/**
 * DÉSIGNER UNE FACTURE DU DOSSIER — par sa référence, ou par le fournisseur quand son BC n'en porte
 * qu'une. Deux factures du même fournisseur ne se départagent pas à sa place.
 */
export function designerFacture(execution: readonly ExecutionDevis[], brut: string): { facture: FactureLue; devis: ExecutionDevis } | { error: string } {
  const q = plier(brut);
  const toutes = execution.flatMap((d) => d.factures.map((f) => ({ facture: f, devis: d })));
  if (toutes.length === 0) return { error: "Aucune facture n'est encore déposée sur ce dossier." };
  if (!q) {
    if (toutes.length === 1) return toutes[0];
    return { error: `Précisez la facture : ${toutes.map(({ facture, devis }) => `${facture.reference ?? "sans référence"} (${devis.fournisseur})`).join(" ; ")}.` };
  }
  const parRef = toutes.filter(({ facture }) => facture.reference && plier(facture.reference) === q);
  if (parRef.length === 1) return parRef[0];
  const parFournisseur = toutes.filter(({ devis }) => plier(devis.fournisseur).includes(q));
  if (parFournisseur.length === 1) return parFournisseur[0];
  const candidats = parRef.length ? parRef : parFournisseur.length ? parFournisseur : toutes;
  return { error: `${parRef.length || parFournisseur.length ? "Plusieurs factures correspondent" : `Aucune facture « ${brut} »`} — factures du dossier : ${candidats.map(({ facture, devis }) => `${facture.reference ?? "sans référence"} (${devis.fournisseur})`).join(" ; ")}.` };
}
