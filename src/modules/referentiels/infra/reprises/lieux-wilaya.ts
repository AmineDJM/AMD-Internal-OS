/**
 * REPRISE « lieux-wilaya » — chaque fiche qui porte un lieu saisi à la main reçoit son `wilayaCode` (lot V2-D).
 *
 * Lit `wilaya` / `city` / `region` / `wilayaPivot` (et `country` des fournisseurs) des cinq modèles de
 * `COLONNES_LIEU`, applique `rattacherFiche` — la même règle que la double écriture — et écrit le code quand il
 * diffère de celui en place. Le texte n'est jamais touché ; `updatedAt` non plus.
 *
 *   liees     = fiches dont le code est posé ou corrigé par ce passage ;
 *   ignorees  = fiches laissées sans code : rien d'écrit (vide), pays étranger, ou texte AMBIGU ;
 *   erreurs   = les cas ambigus, un par ligne (« Praticien ckx… « Oran / Alger » : plusieurs wilayas ») — ceux
 *               qu'un humain corrige dans la fiche, après quoi la double écriture pose le code toute seule.
 * Les fiches déjà à jour ne comptent que dans `lues`. Rejouer ne change rien de plus : le code suit le texte.
 *
 * Un code déjà posé et que le texte ne justifie plus (texte vidé ou devenu ambigu) est REMIS À NUL : la clé est
 * une lecture du texte, pas une seconde saisie qui pourrait le contredire.
 */
import { MODELES_LIEU, COLONNES_LIEU, rattacherFiche, estAmbigu, type ModeleLieu } from "@/modules/lieux/partage";
import { lireLotLieux, poserWilayaCodes, type FicheLieu } from "@/modules/lieux/api";
import { bilanVide, curseurSuivant, lireCurseur } from "../../domaine/reprises/curseur";
import type { BilanReprise, Reprise } from "../../domaine/reprises/types";

const TAILLE_APERCU = 2000;
const MAX_CAS_APERCU = 200;

function decrireCas(modele: ModeleLieu, f: FicheLieu, detail: string): string {
  const texte = Object.values(f.valeurs).filter((v) => v && v.trim()).join(" · ");
  return `${COLONNES_LIEU[modele].libelle} ${f.id} « ${texte.slice(0, 80)} » : ${detail}`;
}

/** Le bilan d'un lot de fiches, et les codes à écrire. Pur sur ses entrées. */
export function evaluerLot(modele: ModeleLieu, fiches: readonly FicheLieu[]): { bilan: BilanReprise; changements: { id: string; code: string | null }[] } {
  const bilan = bilanVide();
  const changements: { id: string; code: string | null }[] = [];
  for (const f of fiches) {
    bilan.lues += 1;
    const r = rattacherFiche(modele, f.valeurs);
    if (r.code !== f.wilayaCode) changements.push({ id: f.id, code: r.code });
    if (r.code === null) {
      bilan.ignorees += 1;
      if (estAmbigu(r)) bilan.erreurs.push(decrireCas(modele, f, r.detail));
    } else if (r.code !== f.wilayaCode) {
      bilan.liees += 1;
    }
  }
  return { bilan, changements };
}

export const repriseLieuxWilaya: Reprise = {
  cle: "lieux-wilaya",
  titre: "Lieux — rattacher chaque fiche à sa wilaya",
  description:
    "Lit la wilaya, la ville ou la région saisies sur les praticiens, établissements, partenaires, fournisseurs et "
    + "secteurs de vente, et pose le code officiel de wilaya (69 wilayas, loi n° 26-06) dans la colonne `wilayaCode`. "
    + "Le texte saisi n'est jamais modifié. Un texte ambigu (deux wilayas, numéro contredit par le nom) reste sans "
    + "code et est listé ; un fournisseur étranger n'a pas de wilaya. Rejouable : le code suit le texte.",

  async apercu() {
    const bilan = bilanVide();
    let ambigus = 0;
    for (const modele of MODELES_LIEU) {
      let apres: string | null = null;
      for (;;) {
        const fiches = await lireLotLieux(modele, apres, TAILLE_APERCU);
        if (!fiches.length) break;
        const lot = evaluerLot(modele, fiches).bilan;
        bilan.lues += lot.lues;
        bilan.liees += lot.liees;
        bilan.ignorees += lot.ignorees;
        ambigus += lot.erreurs.length;
        for (const e of lot.erreurs) if (bilan.erreurs.length < MAX_CAS_APERCU) bilan.erreurs.push(e);
        apres = fiches[fiches.length - 1].id;
        if (fiches.length < TAILLE_APERCU) break;
      }
    }
    if (ambigus > bilan.erreurs.length) bilan.erreurs.push(`… et ${ambigus - bilan.erreurs.length} autre(s) cas ambigu(s).`);
    return bilan;
  },

  async executer({ taille, apresId }) {
    const { source, apresId: apres } = lireCurseur(apresId, MODELES_LIEU);
    const fiches = await lireLotLieux(source, apres, taille);
    const { bilan, changements } = evaluerLot(source, fiches);
    if (changements.length) await poserWilayaCodes(source, changements);
    return { ...bilan, suite: curseurSuivant(MODELES_LIEU, source, fiches, taille) };
  },
};
