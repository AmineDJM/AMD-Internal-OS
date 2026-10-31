/**
 * UNE DEMANDE QUI APPELLE UN CALCUL (lot K1, décision 0031) — règle pure de la sélection d'outils.
 *
 * Mesuré au premier passage réel du banc K1 : la présélection plein texte ne gardait pas `analyser_donnees` dans le
 * budget fixe des outils (le socle et les lectures passaient avant) ; le modèle lisait le budget puis ADDITIONNAIT de
 * tête (« Total alloué : 9 175 500 DZD » — juste ce jour-là, sans preuve). Une demande chiffrée met donc les outils
 * d'analyse EN TÊTE des candidats : ils entrent dans le budget avant les autres, et la lecture qui donne les lignes suit.
 */

const plier = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’']/g, " ");

const CALCUL = /\b(total|totaux|somme|sommes|moyenne|moyen|median|mediane|repartition|part|parts|pourcentage|pourcent|%|evolution|croissance|progress\w*|tendance|compare|comparaison|classement|classe|top|plus (grand|vendu|eleve|fort)s?|ecart|variation|tableau|croise|graphique|courbe|histogramme|camembert|combien|statistiques?|analyse|analyser|par (mois|client|produit|poste|etat|statut|departement|region|delegue|enveloppe|societe|trimestre|annee)|effectif|maximum|minimum|chiffre d affaires)\b/;
const FICHIER = /\.(xlsx|xlsm|csv|tsv)$/i;
const SQL = /\b(ventes?|vendus?|chiffre d affaires|ca|clients?|impaye\w*|sql|toute l entreprise|toutes les societes|tous les departements)\b/;
const PROJECTION = /\b(si .* (augmente|baisse|croit)|par an pendant|projection|simulation|taux compose|interets?|actualis\w*)\b/;

/** Les outils d'analyse à mettre EN TÊTE de la présélection, dans l'ordre — vide : la demande n'appelle aucun calcul. */
export function outilsDAnalyseVoulus(demande: string, pieces: readonly { nom: string }[] = []): string[] {
  const q = plier(demande);
  const tableur = pieces.some((p) => FICHIER.test(p.nom));
  if (!CALCUL.test(q) && !PROJECTION.test(q) && !tableur) return [];
  return [
    ...(tableur ? ["lire_tableur"] : []),
    "analyser_donnees",
    ...(PROJECTION.test(q) ? ["calculer_code"] : []),
    ...(SQL.test(q) && !tableur ? ["requete_sql"] : []),
  ];
}
