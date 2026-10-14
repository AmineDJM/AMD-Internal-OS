import type { ValeursComposables } from "@/lib/legal/piece-emise";

/**
 * POUR LES BANCS — le formulaire que le composeur de pièces (`components/pieces/composer-piece.tsx`, `construireFormData`) envoie
 * pour un bon de commande, construit depuis des VALEURS D'ÉCRAN : celles d'un aperçu ouvert (`apercuBcPoste`,
 * `ouvrirApercuBcDemande`) ou d'une pièce émise (`valeursComposables`). Un banc modifie les valeurs comme la personne les
 * modifie à l'écran, puis envoie le formulaire au vrai point d'entrée. Module pur, sans import de valeur.
 */
export function formulaireDuComposeur(v: ValeursComposables, extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("type", "BON_DE_COMMANDE");
  for (const [k, x] of Object.entries(v.tiers)) fd.set(`tiers${k[0]!.toUpperCase()}${k.slice(1)}`, x);
  const champs = v.champs as unknown as Record<string, string>;
  for (const k of [
    "date", "objet", "referenceAmont", "referenceAmontDate", "contactNom", "contactTelephone", "livraisonAdresse", "livraisonDelai",
    "livraisonDate", "modePaiement", "conditionsPaiement", "tvaDefaut", "remiseGlobale", "notes",
  ]) fd.set(k, champs[k] ?? "");
  if (v.emetteur) {
    fd.set("emetteurPersonnalise", "1");
    fd.set("emetteurAdresse", v.emetteur.adresse);
    fd.set("emetteurTelephone", v.emetteur.telephone);
    fd.set("emetteurEmail", v.emetteur.email);
  } else fd.set("emetteurPersonnalise", "0");
  fd.set("signatairePersonnalise", "1");
  fd.set("signataireNom", v.signataire?.nom ?? "");
  fd.set("signataireQualite", v.signataire?.qualite ?? "");
  fd.set("mentions", v.mentions);
  for (const l of v.lignes) {
    fd.append("ligneDesignation", l.designation);
    fd.append("ligneUnite", l.unite);
    fd.append("ligneDetails", l.details);
    fd.append("ligneQuantite", l.quantite);
    fd.append("lignePrix", l.prix);
    fd.append("ligneRemise", l.remise);
    fd.append("ligneTva", l.tva);
    fd.append("ligneSection", l.section ? "1" : "0");
  }
  for (const t of v.taxes) { fd.append("taxeLibelle", t.libelle); fd.append("taxeTaux", t.taux); }
  for (const [k, x] of Object.entries(extra)) fd.set(k, x);
  return fd;
}
