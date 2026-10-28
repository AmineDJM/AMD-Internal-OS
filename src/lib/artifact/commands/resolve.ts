/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉSOLUTION DES CIBLES (§11, §31–32) — « le deuxième tableau », « la photo en haut à
 * droite », « le paragraphe qui parle de la rémunération ».
 *
 * ── TROIS ISSUES, ET AUCUNE N'EST « À PEU PRÈS » ────────────────────────────────────────
 *
 *   TROUVÉ    un seul objet correspond → on agit.
 *   AMBIGU    plusieurs correspondent → on ne choisit PAS. On rend les candidats, et le
 *             workspace les met en évidence pour que la personne tranche d'un clic (§32).
 *   ABSENT    aucun → on le dit, avec ce qu'on a cherché. Jamais « j'ai fait quelque chose ».
 *
 * Prendre le premier candidat quand il y en a quatre est le défaut le plus coûteux d'un éditeur
 * conversationnel : il modifie le mauvais paragraphe, et comme il annonce « c'est fait », la
 * personne ne le découvre qu'après avoir envoyé le contrat.
 *
 * ── L'ORDRE DES VOIES N'EST PAS ARBITRAIRE ──────────────────────────────────────────────
 *
 * `id` d'abord (un clic ne se discute pas), puis `index` (un rang explicite), puis `contient`
 * (une description), puis `role`. Une voie qui répond ARRÊTE la recherche : si la personne a
 * cliqué, on ne re-cherche pas par texte « au cas où ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Cible } from "@/lib/artifact/commands/ir";
import { normaliserTexte } from "@/lib/artifact/object-model/text";

/** Le minimum qu'un objet doit exposer pour être désignable. */
export interface Designable {
  id: string;
  index: number;
  /** Ce qu'on lit dedans — sert à `contient`. */
  texte: string;
  /** La page où l'objet commence, quand le format en a une (Word). */
  page?: number | null;
}

export type Resolution<T> =
  | { etat: "TROUVE"; objet: T }
  | { etat: "AMBIGU"; candidats: T[]; motif: string }
  | { etat: "ABSENT"; motif: string };

/** Rôles compris, en français comme en anglais — les modèles écrivent les deux. */
const ROLE_PREMIER = new Set(["premier", "première", "first", "debut", "début"]);
const ROLE_DERNIER = new Set(["dernier", "dernière", "last", "fin"]);
const ROLE_TITRE = new Set(["titre", "title", "heading", "entete", "en-tête"]);

export interface OptionsResolution<T> {
  /** Comment reconnaître un titre pour la voie `role: "titre"`. Par défaut : le premier objet. */
  estTitre?: (o: T) => boolean;
  /** Nom de la chose cherchée, pour les messages : « paragraphe », « tableau », « forme ». */
  libelle?: string;
}

/**
 * LES NOMS FÉMININS que ce module sait accorder. « ce document ne contient aucun image » est
 * sorti en production : le refus est juste, il est simplement écrit dans une langue que
 * personne ne parle, et un refus qu'on ne peut pas lire sans buter dessus est un refus qu'on
 * croit moins.
 *
 * La liste est EXPLICITE et vérifiée par `resolve.test.ts` : tout libellé passé à `resoudre`
 * dans le dépôt doit figurer ici ou dans `MASCULINS`. Deviner le genre d'après la terminaison
 * marcherait sur « image » et « forme », et échouerait sur « page » comme sur « graphique ».
 */
const FEMININS = new Set([
  "image", "forme", "diapositive", "page", "cellule", "feuille", "ligne", "colonne", "zone",
]);

/** Les mots que l'on accorde au masculin. Séparés des féminins pour qu'un oubli se VOIE. */
export const MASCULINS = new Set([
  "élément", "paragraphe", "tableau", "graphique", "objet", "titre", "document",
]);

export const LIBELLES_CONNUS = new Set([...FEMININS, ...MASCULINS]);

/** Les accords dont ce module a besoin. Un libellé inconnu retombe au masculin — jamais une erreur. */
function accords(quoi: string) {
  const f = FEMININS.has(quoi);
  return {
    aucun: f ? "aucune" : "aucun",
    quel: f ? "quelle" : "quel",
    le: f ? "la" : "le",
    lequel: f ? "laquelle" : "lequel",
  };
}

/**
 * RÉSOUT une cible parmi des candidats.
 *
 * `contient` est comparé sur du texte NORMALISÉ (accents repliés, casse et espaces ignorés) :
 * une personne qui dicte « remuneration » doit atteindre « Rémunération ». Une correspondance
 * EXACTE, si elle est unique, l'emporte sur les correspondances partielles — sinon « Objet »
 * serait ambigu avec « Objet du contrat » alors que la personne a bien dit lequel.
 */
export function resoudre<T extends Designable>(
  cible: Cible | null,
  candidats: T[],
  opts: OptionsResolution<T> = {},
): Resolution<T> {
  const quoi = opts.libelle ?? "élément";
  const a = accords(quoi);
  if (candidats.length === 0) return { etat: "ABSENT", motif: `ce document ne contient ${a.aucun} ${quoi}` };
  if (!cible) return { etat: "ABSENT", motif: `il faut dire ${a.quel} ${quoi}` };

  // 1 — L'IDENTIFIANT. Un clic, ou une reprise de cible ; sans ambiguïté possible.
  if (cible.id) {
    const o = candidats.find((c) => c.id === cible.id);
    return o
      ? { etat: "TROUVE", objet: o }
      : { etat: "ABSENT", motif: `${a.le} ${quoi} « ${cible.id} » n'existe plus dans ce document` };
  }

  // 0 — LA PAGE, qui RESTREINT tout le reste. « Le troisième paragraphe de la page 12 » : on ne
  // garde que la page 12, et le rang se compte à l'intérieur. Une page seule, sans autre
  // précision, rend ses objets comme candidats : on ne choisit pas pour la personne.
  const page = cible.page ?? null;
  if (page !== null) {
    if (!candidats.some((c) => c.page !== undefined && c.page !== null)) {
      return { etat: "ABSENT", motif: `ce document n'a pas de pagination connue : désignez ${a.le} ${quoi} par son rang ou son texte` };
    }
    const dansLaPage = candidats.filter((c) => c.page === page);
    if (dansLaPage.length === 0) {
      const max = Math.max(...candidats.map((c) => c.page ?? 0));
      return { etat: "ABSENT", motif: `${a.aucun} ${quoi} ne commence page ${page}${max ? ` (le document en compte ${max})` : ""}` };
    }
    if (cible.index !== null) {
      const o = dansLaPage[cible.index - 1];
      return o
        ? { etat: "TROUVE", objet: o }
        : { etat: "ABSENT", motif: `la page ${page} n'a que ${dansLaPage.length} ${quoi}${dansLaPage.length > 1 ? "s" : ""}, pas de n° ${cible.index}` };
    }
    if (!cible.contient && !cible.role) {
      if (dansLaPage.length === 1) return { etat: "TROUVE", objet: dansLaPage[0] };
      return { etat: "AMBIGU", candidats: dansLaPage.slice(0, 12), motif: `la page ${page} contient ${dansLaPage.length} ${quoi}s — ${a.lequel} ?` };
    }
    // `contient` / `role` : la suite travaille sur la page seulement.
    candidats = dansLaPage;
  }

  // 2 — LE RANG HUMAIN. 1 = le premier (§17).
  if (cible.index !== null) {
    const o = candidats.find((c) => c.index === cible.index);
    if (o) return { etat: "TROUVE", objet: o };
    return {
      etat: "ABSENT",
      motif: `il n'y a pas de ${quoi} n° ${cible.index} — ce document en compte ${candidats.length}`,
    };
  }

  // 3 — LE TEXTE. Exact d'abord, partiel ensuite.
  if (cible.contient) {
    const besoin = normaliserTexte(cible.contient);
    if (besoin) {
      const exacts = candidats.filter((c) => normaliserTexte(c.texte) === besoin);
      if (exacts.length === 1) return { etat: "TROUVE", objet: exacts[0] };
      const partiels = candidats.filter((c) => normaliserTexte(c.texte).includes(besoin));
      if (partiels.length === 1) return { etat: "TROUVE", objet: partiels[0] };
      if (partiels.length > 1) {
        return {
          etat: "AMBIGU",
          candidats: partiels.slice(0, 8),
          motif: `${partiels.length} ${quoi}s contiennent « ${cible.contient} » — ${a.lequel} ?`,
        };
      }
      return { etat: "ABSENT", motif: `${a.aucun} ${quoi} ne contient « ${cible.contient} »` };
    }
  }

  // 4 — LE RÔLE.
  if (cible.role) {
    const r = normaliserTexte(cible.role);
    if (ROLE_PREMIER.has(r)) return { etat: "TROUVE", objet: candidats[0] };
    if (ROLE_DERNIER.has(r)) return { etat: "TROUVE", objet: candidats[candidats.length - 1] };
    if (ROLE_TITRE.has(r)) {
      const titres = opts.estTitre ? candidats.filter(opts.estTitre) : [];
      if (titres.length === 1) return { etat: "TROUVE", objet: titres[0] };
      if (titres.length > 1) {
        return { etat: "AMBIGU", candidats: titres.slice(0, 8), motif: `ce document a ${titres.length} titres — lequel ?` };
      }
      // Pas de style de titre déclaré : le premier paragraphe EST le titre, dans les faits.
      return { etat: "TROUVE", objet: candidats[0] };
    }
    return { etat: "ABSENT", motif: `rôle « ${cible.role} » non compris` };
  }

  return { etat: "ABSENT", motif: `il faut dire ${a.quel} ${quoi}` };
}
