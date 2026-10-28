/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉTENTION DES SAUVEGARDES — quelles copies garder, lesquelles purger. Module PUR (aucune E/S),
 * appelé par le workflow `.github/workflows/sauvegarde-base.yml` et éprouvé par `retention.test.ts`.
 *
 * Politique « grand-père / père / fils », la plus courante et la plus facile à expliquer :
 *   • les QUOTIDIENNES des 14 derniers jours ;
 *   • une HEBDOMADAIRE (la plus récente de chaque semaine ISO) sur 8 semaines ;
 *   • une MENSUELLE (la plus récente de chaque mois) sur 12 mois.
 * Une copie est gardée si UNE des trois règles la retient. La plus récente n'est JAMAIS purgée,
 * même vieille (une sauvegarde qui échoue depuis des semaines ne doit pas effacer la dernière bonne).
 *
 * Entrée : des clés d'objets nommées `…/amd-AAAAMMJJTHHMMSSZ.dump.gpg` (horodatage UTC).
 * Une clé dont la date ne se lit pas n'est JAMAIS purgée (on ne détruit pas ce qu'on ne comprend pas).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const POLITIQUE = { quotidiennes: 14, hebdomadaires: 8, mensuelles: 12 };

const MOTIF = /amd-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump\.gpg$/;

/** La date UTC lue dans la clé, ou `null`. */
export function dateDeCle(cle) {
  const m = MOTIF.exec(cle);
  if (!m) return null;
  const [, a, mo, j, h, mi, s] = m.map(Number);
  const d = new Date(Date.UTC(a, mo - 1, j, h, mi, s));
  return Number.isNaN(d.getTime()) ? null : d;
}

const JOUR = 86_400_000;
const jourUtc = (d) => d.toISOString().slice(0, 10);
const moisUtc = (d) => d.toISOString().slice(0, 7);
/** Semaine ISO « AAAA-Wss » (lundi = premier jour). */
function semaineIso(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const jour = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - jour);
  const debut = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const n = Math.ceil(((t.getTime() - debut.getTime()) / JOUR + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(n).padStart(2, "0")}`;
}

/**
 * Les clés à PURGER, en appliquant la politique à `maintenant`.
 * @param {string[]} cles
 * @param {Date} maintenant
 * @param {{ quotidiennes: number, hebdomadaires: number, mensuelles: number }} [politique]
 * @returns {string[]}
 */
export function clesAPurger(cles, maintenant, politique = POLITIQUE) {
  const lues = cles
    .map((cle) => ({ cle, date: dateDeCle(cle) }))
    .filter((x) => x.date !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime()); // la plus récente d'abord
  if (lues.length === 0) return [];

  const garder = new Set([lues[0].cle]);
  const premiereDe = (cleDeGroupe, limite, horizonJours) => {
    const vus = new Set();
    for (const { cle, date } of lues) {
      if ((maintenant.getTime() - date.getTime()) / JOUR > horizonJours) continue;
      const g = cleDeGroupe(date);
      if (vus.has(g)) continue;
      vus.add(g);
      if (vus.size > limite) break;
      garder.add(cle);
    }
  };
  premiereDe(jourUtc, politique.quotidiennes, politique.quotidiennes);
  premiereDe(semaineIso, politique.hebdomadaires, politique.hebdomadaires * 7);
  premiereDe(moisUtc, politique.mensuelles, politique.mensuelles * 31);

  return lues.filter((x) => !garder.has(x.cle)).map((x) => x.cle);
}

// Exécution directe : lit sur l'entrée standard la sortie JSON de `aws s3api list-objects-v2`
// et écrit une clé à purger par ligne.
if (import.meta.url === `file://${process.argv[1]}`) {
  let brut = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { brut += c; });
  process.stdin.on("end", () => {
    const json = brut.trim() ? JSON.parse(brut) : {};
    const cles = (json.Contents ?? []).map((o) => o.Key);
    for (const cle of clesAPurger(cles, new Date())) process.stdout.write(`${cle}\n`);
  });
}
