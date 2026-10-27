import crypto from "node:crypto";
import { chargerCles, type ClesCoffre } from "./cle";
import { chiffrer, dechiffrer, empreinte, ErreurDechiffrement } from "./chiffrement";
import { refTitulaire, type DepotCoffre, type ResumeDonneeSensible } from "./depot";
import { derniersCaracteres, masque, normaliser, type NatureCoffre } from "./natures";
import { peutLire, type DecisionLecture, type LecteurCoffre, type MotifAccord, type TitulaireCoffre } from "./politique";

/**
 * LE SERVICE DU COFFRE — le seul chemin entre une valeur en clair et le stockage.
 *
 * Déposer : normaliser (refus d'une valeur mal formée), chiffrer, calculer l'empreinte et le masque,
 * puis confier au dépôt. Un même titulaire qui redépose la même valeur ne crée pas de doublon.
 * Le dépôt n'a pas de politique propre : c'est l'appelant (action serveur, moteur d'enrichissement)
 * qui tient la porte du geste, et déposer ne révèle rien que l'appelant n'ait déjà.
 *
 * Lire : décider (`peutLire`), JOURNALISER — accord comme refus, dans la transaction de lecture —,
 * puis seulement déchiffrer. Le compte d'une personne titulaire est résolu ici (`compteDe`) pour
 * que « la personne elle-même » lise les siennes.
 */

export interface DependancesCoffre {
  depot: DepotCoffre;
  /** Clés du coffre ; lues dans l'environnement à chaque usage par défaut. */
  cles?: () => ClesCoffre;
  /** Compte utilisateur d'une fiche Personne, `null` si elle n'en a pas. */
  compteDe?: (personneId: string) => Promise<string | null>;
  horloge?: () => Date;
  nouvelId?: () => string;
}

export interface EntreeDepot {
  titulaire: TitulaireCoffre;
  nature: NatureCoffre;
  valeur: string;
  deposeParId: string | null;
  pieceSourceId?: string | null;
  valideDu?: Date | null;
  valideAu?: Date | null;
}

export type ResultatDepot =
  | { ok: true; id: string; masque: string; dejaPresente: boolean }
  | { ok: false; erreur: string };

export type ResultatLecture =
  | { ok: true; valeur: string; nature: NatureCoffre; masque: string; motif: MotifAccord }
  | { ok: false; code: "INTROUVABLE" | "REFUSE" | "ILLISIBLE" | "GESTE_MANQUANT"; raison: string };

export function creerServiceCoffre(dep: DependancesCoffre) {
  const cles = dep.cles ?? (() => chargerCles());
  const horloge = dep.horloge ?? (() => new Date());
  const nouvelId = dep.nouvelId ?? (() => crypto.randomUUID());
  const compteDe = dep.compteDe ?? (async () => null);

  async function deposer(e: EntreeDepot): Promise<ResultatDepot> {
    const n = normaliser(e.nature, e.valeur);
    if (!n.ok) return { ok: false, erreur: n.erreur };
    if (e.titulaire.genre === "ORGANISATION" && e.nature !== "IBAN" && e.nature !== "RIB") {
      return { ok: false, erreur: "Une organisation ne dépose au coffre que ses coordonnées bancaires." };
    }
    const k = cles();
    const ref = refTitulaire(e.titulaire);
    const emp = empreinte(k, e.nature, n.valeur);
    const derniers = derniersCaracteres(e.nature, n.valeur);
    const existantes = await dep.depot.chercherParEmpreinte(e.nature, emp, ref);
    if (existantes.length) return { ok: true, id: existantes[0].id, masque: masque(e.nature, existantes[0].derniers4), dejaPresente: true };
    const id = nouvelId();
    await dep.depot.deposer({
      id,
      titulaire: ref,
      nature: e.nature,
      valeurChiffree: chiffrer(k, e.nature, id, n.valeur),
      empreinte: emp,
      derniers4: derniers,
      pieceSourceId: e.pieceSourceId ?? null,
      valideDu: e.valideDu ?? null,
      valideAu: e.valideAu ?? null,
      deposeParId: e.deposeParId,
      deposeLe: horloge(),
    });
    return { ok: true, id, masque: masque(e.nature, derniers), dejaPresente: false };
  }

  async function lire(p: { lecteur: LecteurCoffre; id: string; geste: string }): Promise<ResultatLecture> {
    const geste = p.geste.trim();
    if (!geste) return { ok: false, code: "GESTE_MANQUANT", raison: "Toute lecture du coffre dit pour quel geste elle est faite." };
    let decision: DecisionLecture | null = null;
    const r = await dep.depot.lireAvecJournal(p.id, async (d) => {
      const titulaire: TitulaireCoffre = d.titulaire.genre === "PERSONNE"
        ? { ...d.titulaire, userId: p.lecteur.genre === "IA" ? null : await compteDe(d.titulaire.personneId) }
        : d.titulaire;
      const prise = peutLire(p.lecteur, d.nature, titulaire);
      decision = prise;
      return {
        donneeId: d.id,
        lecteurGenre: p.lecteur.genre,
        lecteurId: p.lecteur.genre === "UTILISATEUR" ? p.lecteur.userId : null,
        lecteurNom: p.lecteur.genre === "IA" ? p.lecteur.nom : null,
        geste,
        autorise: prise.autorise,
        motif: prise.motif,
        le: horloge(),
      };
    });
    if (!r) return { ok: false, code: "INTROUVABLE", raison: "Donnée introuvable au coffre." };
    const { donnee, acces } = r;
    const prise = decision as DecisionLecture | null;
    if (!acces.autorise || !prise?.autorise) {
      return { ok: false, code: "REFUSE", raison: prise && !prise.autorise ? prise.raison : "Lecture refusée." };
    }
    try {
      const valeur = dechiffrer(cles(), donnee.nature, donnee.id, donnee.valeurChiffree);
      return { ok: true, valeur, nature: donnee.nature, masque: masque(donnee.nature, donnee.derniers4), motif: prise.motif };
    } catch (err) {
      if (err instanceof ErreurDechiffrement) return { ok: false, code: "ILLISIBLE", raison: err.message };
      throw err;
    }
  }

  /**
   * « À qui est cette valeur ? » sans rien déchiffrer : seules reviennent les données que le lecteur
   * pourrait lire (savoir qu'un RIB appartient à quelqu'un est déjà une information du coffre).
   * Un modèle d'IA ne cherche pas plus qu'il ne lit.
   */
  async function chercher(p: { lecteur: LecteurCoffre; nature: NatureCoffre; valeur: string }): Promise<ResumeDonneeSensible[]> {
    if (p.lecteur.genre === "IA") return [];
    const n = normaliser(p.nature, p.valeur);
    if (!n.ok) return [];
    const trouvees = await dep.depot.chercherParEmpreinte(p.nature, empreinte(cles(), p.nature, n.valeur));
    const visibles: ResumeDonneeSensible[] = [];
    for (const d of trouvees) {
      const titulaire: TitulaireCoffre = d.titulaire.genre === "PERSONNE" ? { ...d.titulaire, userId: await compteDe(d.titulaire.personneId) } : d.titulaire;
      if (peutLire(p.lecteur, d.nature, titulaire).autorise) visibles.push(d);
    }
    return visibles;
  }

  return { deposer, lire, chercher };
}

export type ServiceCoffre = ReturnType<typeof creerServiceCoffre>;
