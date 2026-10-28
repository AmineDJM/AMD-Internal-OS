/**
 * UNE REPRISE QUI LIT PLUSIEURS TABLES ET ÉCRIT DES LIGNES À IDENTIFIANT DÉTERMINISTE (serveur).
 *
 * Les reprises « adresses » et « points-de-contact » ont la même forme : pour chaque source (une table métier),
 * lire un lot de fiches, en tirer des lignes CANDIDATES portant une `cle`, et insérer celles qui n'existent pas
 * encore. L'identifiant d'une ligne est `<préfixe>_<24 premiers hexa du SHA-256 de sa clé>` : rejouer la reprise
 * — ou la relancer après qu'un autre lot a créé de nouvelles Personnes — n'insère que ce qui manque
 * (`createMany … skipDuplicates`), sans jamais dédoubler ni écraser une ligne corrigée à la main.
 *
 *   lues     = fiches sources lues ;
 *   liees    = fiches dont au moins une ligne candidate existe désormais (créée ou déjà là) ;
 *   creees   = lignes insérées (à blanc : qui le seraient) ;
 *   ignorees = fiches sans titulaire (Personne / Organisation pas encore créée) ou sans rien à reprendre ;
 *   erreurs  = valeurs illisibles ou non reprises, une phrase par cas (bornées dans l'aperçu).
 */
import { createHash } from "node:crypto";
import { bilanVide, curseurSuivant, lireCurseur } from "./curseur";
import type { BilanReprise, Reprise } from "./types";

export interface LigneSource<C> {
  id: string;
  /** Faux tant que la fiche n'est rattachée à aucune Personne / Organisation. */
  aTitulaire: boolean;
  candidats: C[];
  /** Ce qu'un humain doit voir (valeur illisible, adresse à l'étranger…). */
  notes: string[];
}

export interface SourceReprise<C> {
  /** Nom de la table lue — c'est aussi le préfixe du curseur. */
  table: string;
  lire(apresId: string | null, taille: number): Promise<LigneSource<C>[]>;
}

export interface Ecrivain<C> {
  /** Les identifiants déjà en base parmi ceux donnés. */
  existants(ids: string[]): Promise<Set<string>>;
  /** Insère, en ignorant les identifiants déjà pris ; rend le nombre inséré. */
  inserer(lignes: (C & { id: string })[]): Promise<number>;
}

/** L'identifiant déterministe d'une ligne de référentiel reprise. */
export function idDeterministe(prefixe: string, cle: string): string {
  return `${prefixe}_${createHash("sha256").update(cle).digest("hex").slice(0, 24)}`;
}

const TAILLE_APERCU = 1000;
const MAX_NOTES_APERCU = 200;

export function repriseParSources<C extends { cle: string }>(def: {
  cle: string;
  titre: string;
  description: string;
  prefixe: string;
  sources: readonly SourceReprise<C>[];
  ecrivain: Ecrivain<C>;
}): Reprise {
  const tables = def.sources.map((s) => s.table);
  const source = (table: string) => def.sources.find((s) => s.table === table)!;

  /** Évalue un lot : bilan + lignes à insérer (dédoublonnées dans le lot, absentes de la base). */
  async function evaluer(table: string, lignes: LigneSource<C>[]): Promise<{ bilan: BilanReprise; nouvelles: (C & { id: string })[]; sansTitulaire: number }> {
    const bilan = bilanVide();
    const parId = new Map<string, C & { id: string }>();
    let sansTitulaire = 0;
    for (const l of lignes) {
      bilan.lues += 1;
      for (const n of l.notes) bilan.erreurs.push(`${table} ${l.id} : ${n}`);
      if (!l.aTitulaire) { sansTitulaire += 1; bilan.ignorees += 1; continue; }
      if (!l.candidats.length) { bilan.ignorees += 1; continue; }
      bilan.liees += 1;
      for (const c of l.candidats) {
        const id = idDeterministe(def.prefixe, c.cle);
        if (!parId.has(id)) parId.set(id, { ...c, id });
      }
    }
    const deja = await def.ecrivain.existants([...parId.keys()]);
    const nouvelles = [...parId.values()].filter((c) => !deja.has(c.id));
    return { bilan, nouvelles, sansTitulaire };
  }

  const noteSansTitulaire = (n: number) =>
    `${n} fiche(s) sans Personne ni Organisation : rien à leur rattacher pour l'instant — relancer cette reprise après les reprises des personnes et des organisations.`;

  return {
    cle: def.cle,
    titre: def.titre,
    description: def.description,

    async apercu() {
      const total = bilanVide();
      let notes = 0;
      let sansTitulaire = 0;
      for (const table of tables) {
        let apres: string | null = null;
        for (;;) {
          const lignes = await source(table).lire(apres, TAILLE_APERCU);
          if (!lignes.length) break;
          const { bilan, nouvelles, sansTitulaire: st } = await evaluer(table, lignes);
          total.lues += bilan.lues;
          total.liees += bilan.liees;
          total.ignorees += bilan.ignorees;
          total.creees += nouvelles.length;
          sansTitulaire += st;
          notes += bilan.erreurs.length;
          for (const e of bilan.erreurs) if (total.erreurs.length < MAX_NOTES_APERCU) total.erreurs.push(e);
          apres = lignes[lignes.length - 1].id;
          if (lignes.length < TAILLE_APERCU) break;
        }
      }
      if (notes > total.erreurs.length) total.erreurs.push(`… et ${notes - total.erreurs.length} autre(s) valeur(s) non reprise(s).`);
      if (sansTitulaire) total.erreurs.push(noteSansTitulaire(sansTitulaire));
      return total;
    },

    async executer({ taille, apresId }) {
      const { source: table, apresId: apres } = lireCurseur(apresId, tables);
      const lignes = await source(table).lire(apres, taille);
      const { bilan, nouvelles, sansTitulaire } = await evaluer(table, lignes);
      bilan.creees = nouvelles.length ? await def.ecrivain.inserer(nouvelles) : 0;
      if (sansTitulaire) bilan.erreurs.push(noteSansTitulaire(sansTitulaire));
      return { ...bilan, suite: curseurSuivant(tables, table, lignes, taille) };
    },
  };
}
