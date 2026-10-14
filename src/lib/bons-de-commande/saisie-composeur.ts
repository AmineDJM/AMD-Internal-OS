import { MODES_PAIEMENT, type ModePaiement } from "@/lib/artifact/factory/commercial";
import { lignesDepuisListes, type ListesDeLignes } from "@/lib/artifact/factory/lignes-saisies";
import type { SaisieBc } from "@/lib/bons-de-commande/brouillon";
import { memeNumero } from "@/lib/bons-de-commande/numero-reference";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LE COMPOSEUR ENVOIE POUR UN BON DE COMMANDE — UNE SEULE LECTURE (Direction, 14/10/2026).
 *
 * Le composeur de pièces (`components/pieces/composer-piece.tsx`) sert à CORRIGER L'APERÇU d'un BC (brouillon, sans
 * numéro) et à RÉVISER un BC émis — depuis le poste Ad & Pro comme depuis la fiche d'une demande au secrétariat. Les quatre
 * gestes lisent son formulaire ICI : deux lecteurs du même formulaire finiraient par ne pas porter les mêmes champs (§118.5),
 * et c'est exactement ce qui était arrivé (l'aperçu du poste ne lisait que la livraison, le fournisseur et quatre colonnes
 * des lignes, la révision lisait tout).
 *
 * Une clé ABSENTE garde sa valeur ; présente et vide, elle l'efface (§118.152). Le résultat a la forme de
 * `ModificationsDocument` (fabrique) : la révision le passe tel quel, le brouillon le garde (`BrouillonBc.corrections`).
 *
 * Note de contrat (§118.87c) : ces champs sont lus dans un module importé, que la dérivation des contrats ne suit pas. Les
 * actions qui l'appellent sont des gestes d'ÉCRAN, exclus du chemin d'Adam (`action-registry.ts`, « X ») : aucune n'est
 * décrite à un modèle, et la liste amputée ne peut donc refuser aucun appel légitime.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const brut = (fd: FormData, cle: string): string | null => {
  const v = fd.get(cle);
  return typeof v === "string" ? v : null;
};

export function lireSaisieDuComposeur(formData: FormData): SaisieBc {
  const champ = (cle: string): string | null => { const v = brut(formData, cle); return v && v.trim() ? v.trim() : null; };
  const pourcent = (cle: string): number | null => {
    const v = (brut(formData, cle) ?? "").replace(/[\s  ]/g, "").replace(",", ".");
    const n = v ? Number(v) : Number.NaN;
    return Number.isFinite(n) ? n / 100 : null;
  };
  const listes: ListesDeLignes = {
    designations: formData.getAll("ligneDesignation").map(String), details: formData.getAll("ligneDetails").map(String),
    quantites: formData.getAll("ligneQuantite").map(String), prix: formData.getAll("lignePrix").map(String),
    remises: formData.getAll("ligneRemise").map(String), tvas: formData.getAll("ligneTva").map(String), sections: formData.getAll("ligneSection").map(String),
    unites: formData.getAll("ligneUnite").map(String),
  };
  const m: SaisieBc = {};
  if (listes.designations.length > 0) m.lignes = lignesDepuisListes(listes);
  if (formData.has("tiersNom")) {
    m.tiers = {
      nom: champ("tiersNom") ?? "",
      ...(formData.has("tiersAdresse") ? { adresse: champ("tiersAdresse") } : {}),
      ...(formData.has("tiersTelephone") ? { telephone: champ("tiersTelephone") } : {}),
      ...(formData.has("tiersEmail") ? { email: champ("tiersEmail") } : {}),
      ...(formData.has("tiersRc") ? { rc: champ("tiersRc") } : {}),
      ...(formData.has("tiersNif") ? { nif: champ("tiersNif") } : {}),
      ...(formData.has("tiersAi") ? { ai: champ("tiersAi") } : {}),
      ...(formData.has("tiersNis") ? { nis: champ("tiersNis") } : {}),
    };
  }
  if (formData.has("date")) m.date = champ("date");
  if (formData.has("objet")) m.objet = champ("objet");
  if (formData.has("notes")) m.notes = champ("notes");
  if (formData.has("referenceAmont")) m.referenceAmont = champ("referenceAmont");
  if (formData.has("referenceAmontDate")) m.referenceAmontDate = champ("referenceAmontDate");
  if (formData.has("conditionsPaiement")) m.conditionsPaiement = champ("conditionsPaiement");
  if (formData.has("modePaiement")) {
    const mode = champ("modePaiement");
    m.modePaiement = mode && (MODES_PAIEMENT as readonly string[]).includes(mode) ? (mode as ModePaiement) : null;
  }
  if (formData.has("tvaDefaut")) m.tvaDefaut = pourcent("tvaDefaut");
  if (formData.has("remiseGlobale")) m.remiseGlobale = pourcent("remiseGlobale");
  if (formData.has("taxeLibelle")) {
    const libelles = formData.getAll("taxeLibelle").map(String);
    const taux = formData.getAll("taxeTaux").map(String);
    const taxes = libelles.map((libelle, i) => {
      const t = (taux[i] ?? "").replace(/[\s  ]/g, "").replace(",", ".");
      return { libelle: libelle.trim(), taux: t && Number.isFinite(Number(t)) ? Number(t) / 100 : Number.NaN };
    }).filter((t) => t.libelle || Number.isFinite(t.taux));
    m.taxes = taxes.length ? taxes : null;
  }
  if (formData.has("livraisonAdresse") || formData.has("livraisonDelai") || formData.has("livraisonDate")) {
    m.livraison = {
      ...(formData.has("livraisonAdresse") ? { adresse: champ("livraisonAdresse") } : {}),
      ...(formData.has("livraisonDelai") ? { delai: champ("livraisonDelai") } : {}),
      ...(formData.has("livraisonDate") ? { date: champ("livraisonDate") } : {}),
    };
  }
  if (formData.has("contactNom") || formData.has("contactTelephone")) {
    m.contact = {
      ...(formData.has("contactNom") ? { nom: champ("contactNom") } : {}),
      ...(formData.has("contactTelephone") ? { telephone: champ("contactTelephone") } : {}),
    };
  }
  if (formData.has("letterheadId")) m.letterheadId = champ("letterheadId");
  const coordonnees = brut(formData, "emetteurPersonnalise");
  if (coordonnees === "1") m.coordonneesEmetteur = { adresse: champ("emetteurAdresse"), telephone: champ("emetteurTelephone"), email: champ("emetteurEmail") };
  else if (coordonnees !== null) m.coordonneesEmetteur = null;
  if (brut(formData, "signatairePersonnalise") === "1") m.signataire = champ("signataireNom") ? { nom: champ("signataireNom") ?? "", qualite: champ("signataireQualite") } : null;
  if (formData.has("mentions")) m.mentions = (brut(formData, "mentions") ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  // Présent : le numéro modifié, ou `null` (le numéro actuel — efface un numéro modifié gardé sur un brouillon).
  if (formData.has("numeroRevise")) m.numero = numeroReviseDuFormulaire(formData);
  return m;
}

/**
 * LE NUMÉRO DE RÉFÉRENCE MODIFIÉ (Direction, 14/10/2026) — le champ « N° de référence » du composeur sur un BC qui a déjà son
 * numéro (révision, BC à régénérer) : `numeroRevise`, comparé à `numeroActuel`. Vide ou identique : pas de changement.
 */
export function numeroReviseDuFormulaire(formData: FormData): string | null {
  const v = (brut(formData, "numeroRevise") ?? "").trim();
  if (!v) return null;
  return memeNumero(v, brut(formData, "numeroActuel")) ? null : v;
}

/**
 * LES REFUS DE LA SAISIE, avant toute composition : une ligne sans désignation, une quantité ou un prix illisible, une date
 * de livraison mal écrite — dits en nommant la ligne. `null` : la saisie se compose (la fabrique vérifie le reste).
 */
export function refusDeLaSaisie(s: SaisieBc): string | null {
  if (s.lignes) {
    if (!s.lignes.some((l) => !l.section)) return "Le bon de commande doit garder au moins une ligne chiffrée.";
    const vide = s.lignes.findIndex((l) => !l.designation);
    if (vide >= 0) return `Ligne ${vide + 1} : la désignation est obligatoire.`;
    const mauvaise = s.lignes.findIndex((l) => !l.section && (!Number.isFinite(l.quantite) || l.quantite <= 0 || !Number.isFinite(l.prixUnitaire) || l.prixUnitaire < 0));
    if (mauvaise >= 0) return `Ligne ${mauvaise + 1} : la quantité (supérieure à zéro) et le prix unitaire (positif) doivent être des nombres.`;
  }
  const dateLivraison = s.livraison?.date;
  if (dateLivraison && !/^\d{4}-\d{2}-\d{2}$/.test(dateLivraison)) return "La date de livraison s'écrit AAAA-MM-JJ.";
  if (s.date && !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) return "La date du bon de commande s'écrit AAAA-MM-JJ.";
  return null;
}
