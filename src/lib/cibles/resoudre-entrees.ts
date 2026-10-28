import type { SessionUser } from "@/lib/rbac";
import type { ContratAction, ChampAction } from "@/lib/actions/contrat";
import { resoudreCible, direRefus, ressembleAUnId, type Cible } from "./resoudre";
import { entiteDuModele } from "./modele-entite";
import { findPeople } from "@/lib/directory/resolve";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « NIVOLEX » LÀ OÙ L'ACTION ATTEND UN `cuid` — le pont que `estReference` annonçait.
 *
 * ── CE QUE CE MODULE FERME ───────────────────────────────────────────────────────────────
 *
 * `resoudreCible` existait, testé, documenté — et n'avait AUCUN appelant de production : le
 * seul import du dépôt était son propre test. §118.14 dans sa forme exacte, sur la pièce qui
 * décide si une personne peut parler à Adam en français ou doit lui dicter des identifiants.
 * Le chemin générique, lui, exigeait le `cuid` : `setRegulatoryPriority` refusait « Nivolex »
 * en annonçant un dossier introuvable, alors que le dossier était là et que le résolveur
 * capable de le trouver dormait à deux dossiers de distance (§118.63 : un « je ne peux pas »
 * écrit dans le CODE).
 *
 * ── SUR QUOI LA RÉSOLUTION S'ARME ────────────────────────────────────────────────────────
 *
 * Sur le SCHÉMA. `ChampAction.modele` vient de la relation Prisma (`CareBeneficiary.doctorId`
 * → `MedicalDoctor`), pas d'une ressemblance de noms — mesuré, la ressemblance ajoutait 35
 * champs sur 730 et faisait pointer le `messageId` de la messagerie Microsoft vers le modèle
 * `Message` de l'ERP. Un champ de plus obtenu en devinant vaut moins qu'un champ de moins
 * obtenu à coup sûr, parce que l'erreur ici s'appelle « agir sur la mauvaise ligne » (§104.7).
 *
 * ── LES QUATRE ISSUES, ET POURQUOI AUCUNE NE PEUT MANQUER ────────────────────────────────
 *
 *  1. La valeur a la FORME d'un identifiant → on n'y touche pas, et l'on n'interroge pas la
 *     base : un plan enchaîné passe l'id qu'il tient déjà (§118.35).
 *  2. UNE cible retenue → on substitue, et la CARTE le montre. C'est le point qui compte :
 *     la personne confirme la LIGNE RÉSOLUE, pas le mot qu'elle a écrit. Résoudre à nouveau
 *     à l'exécution pourrait désigner une autre ligne entre la carte et le clic.
 *  3. ZÉRO ou PLUSIEURS → REFUS, avec les candidats. Laisser passer le texte produirait une
 *     erreur de clé étrangère dont personne ne tirerait rien, là où le refus nomme le remède.
 *  4. Rien à quoi s'accrocher (le schéma se tait, ou l'objet n'a pas de portée de lecture
 *     déclarée) → on LAISSE PASSER en le DISANT. Une garde qui refuse ce qu'elle ne comprend
 *     pas est désactivée dans la semaine (§118.16) ; et l'action revérifie de toute façon.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une substitution faite — de quoi l'AFFICHER sur la carte, jamais un identifiant nu. */
export interface Substitution {
  champ: string;
  /** Ce que la personne (ou le modèle) avait écrit. */
  texte: string;
  /** Le libellé de l'objet — « Dossier réglementaire ». */
  objet: string;
  cible: Cible;
}

/** Un champ qu'on n'a pas cherché à résoudre, et POURQUOI — jamais un silence (§118.26). */
export interface NonResolu {
  champ: string;
  texte: string;
  raison: string;
}

/** Les clés sont TOUJOURS les mêmes ; c'est la valeur qui dit l'absence (§118.20). */
export interface EntreesResolues {
  entree: Record<string, unknown>;
  substitutions: Substitution[];
  /** Les refus — ambiguïté ou rien trouvé. Non vide = l'appelant ne doit PAS proposer. */
  refus: string[];
  nonResolus: NonResolu[];
}

/** Un champ porte-t-il une désignation d'objet ? La cardinalité ne change pas la réponse. */
const porteUneReference = (ch: ChampAction): boolean =>
  Boolean(ch.modele) && (ch.type === "reference" || ch.type === "liste");

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PERSONNE NE SE CHERCHE PAS DANS LA LISTE DES COMPTES — l'exception, et sa preuve.
 *
 * Le registre porte `User` sous le module ADMIN : le lire demande le droit d'ADMINISTRATION,
 * ce qui est juste pour « la liste des comptes de l'ERP » et FAUX pour « qui est responsable de
 * ce dossier ». Mesuré par le banc : un chef de service désignant un collègue par son nom
 * recevait « Aucun compte utilisateur « … » dans votre périmètre » — un « je ne peux pas »
 * artificiel sur le geste le plus courant de l'ERP (§118.63).
 *
 * L'entreprise a déjà tranché, à deux endroits : l'outil `search_people` de la conversation et
 * `resolvePeopleList` des ops de domaine cherchent tous deux une personne SANS garde
 * d'administration — nommer un collègue n'est pas un acte privilégié ici, choisir son rôle
 * l'est. On ne fabrique donc pas une troisième vérité (§118.5) : on passe par l'ANNUAIRE
 * canonique (`directory/resolve.ts`), celui qui connaît les alias, les fiches RH et les
 * contacts, et dont l'ordre des sources EST la règle métier.
 *
 * Ce que cela n'ouvre pas : le droit d'ASSIGNER. L'action revérifie, comme au clic sur le
 * bouton — et les gestes qui touchent au compte lui-même restent refusés à la compilation
 * (`MODELES_INTERDITS`, §118.6).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const MODELE_PERSONNE = "User";

async function designerUnePersonne(texte: string): Promise<{ retenu: Cible[]; candidats: Cible[] }> {
  const trouves = await findPeople(texte, 6).catch(sansBloquer("resoudre-entrees.designerUnePersonne.findPeople", []));
  // SANS COMPTE, PAS DE RÉFÉRENCE : l'annuaire connaît aussi des fiches RH et des contacts
  // externes, qui n'ont pas d'identifiant `User`. Les garder ferait proposer une personne qu'on
  // ne pourrait pas écrire dans le champ — et un candidat qu'on ne peut pas retenir n'aide pas.
  const cibles: Cible[] = trouves.flatMap((p) => (p.userId
    ? [{ id: p.userId, titre: p.name, sousTitre: p.jobTitle ?? p.company ?? null }]
    : []));
  // UNE liste de plusieurs n'en désigne AUCUNE : la collapser choisirait le destinataire à la
  // place d'un humain, et deux homonymes existent pour de vrai dans cette entreprise (§118.34).
  return cibles.length === 1 ? { retenu: cibles, candidats: [] } : { retenu: [], candidats: cibles };
}

/**
 * QUELS CHAMPS ACCEPTENT UN NOM ? — ce que le contrat ne peut pas dire tout seul.
 *
 * `direContrat` est PUR : il annonce `dossierId : reference→RegulatoryProduct`, ce qui dit ce
 * que le champ DÉSIGNE mais pas si l'on saura le retrouver — cela dépend du registre, qui vit
 * ici. Sans cette phrase, un modèle lit « reference » et fabrique un identifiant plutôt que
 * d'écrire le nom qu'il a sous les yeux : ce que le code ACCEPTE, la fiche doit le dire
 * (§118.19).
 */
export function champsDesignables(contrat: ContratAction): { champ: string; objet: string }[] {
  const out: { champ: string; objet: string }[] = [];
  for (const ch of contrat.champs) {
    if (!porteUneReference(ch)) continue;
    if (ch.modele === MODELE_PERSONNE) { out.push({ champ: ch.nom, objet: "Personne" }); continue; }
    const def = entiteDuModele(ch.modele!);
    if (def) out.push({ champ: ch.nom, objet: def.label });
  }
  return out;
}

export async function resoudreEntrees(
  user: SessionUser,
  contrat: ContratAction,
  entree: Readonly<Record<string, unknown>>,
): Promise<EntreesResolues> {
  const sortie: Record<string, unknown> = { ...entree };
  const substitutions: Substitution[] = [];
  const refus: string[] = [];
  const nonResolus: NonResolu[] = [];

  for (const ch of contrat.champs) {
    const brut = entree[ch.nom];
    if (brut === undefined || brut === null || brut === "") continue;
    if (ch.type !== "reference" && ch.type !== "liste") continue;

    // LA CARDINALITÉ D'ABORD : une liste se résout élément par élément, et l'on réécrit une
    // liste. La collapser choisirait une cible parmi plusieurs à la place d'un humain (§118.16).
    const valeurs = Array.isArray(brut) ? brut.map(String) : [String(brut)];
    const resolues: string[] = [];
    let modifie = false;

    for (const texte of valeurs) {
      if (!texte.trim()) { resolues.push(texte); continue; }
      if (ressembleAUnId(texte)) { resolues.push(texte); continue; }

      if (!porteUneReference(ch)) {
        resolues.push(texte);
        // Une LISTE sans modèle n'est pas forcément une liste de références (« tags ») : se
        // taire est juste. Un champ de type `reference` sans modèle, lui, VA échouer chez
        // l'action, et le taire ferait lire l'échec comme une absence (§118.26).
        if (ch.type === "reference") {
          nonResolus.push({
            champ: ch.nom, texte,
            raison: `le schéma ne dit pas quel objet « ${ch.nom} » désigne — donnez l'identifiant, `
              + `ou passez par l'écran qui porte ce geste`,
          });
        }
        continue;
      }

      if (ch.modele === MODELE_PERSONNE) {
        const p = await designerUnePersonne(texte);
        if (p.retenu.length === 1) {
          resolues.push(p.retenu[0]!.id);
          substitutions.push({ champ: ch.nom, texte, objet: "Personne", cible: p.retenu[0]! });
          modifie = true;
          continue;
        }
        resolues.push(texte);
        refus.push(`« ${ch.nom} » : ${p.candidats.length === 0
          ? `aucune personne « ${texte} » dans l'annuaire.`
          : `plusieurs personnes correspondent à « ${texte} » : `
            + `${p.candidats.map((c) => (c.sousTitre ? `${c.titre} — ${c.sousTitre}` : c.titre)).join(" ; ")}. Précisez laquelle.`}`);
        continue;
      }

      const def = entiteDuModele(ch.modele!);
      if (!def) {
        // L'OBJET EXISTE, mais aucune portée de lecture n'est déclarée pour lui. Chercher
        // quand même ferait EXISTER, le temps d'un refus, des lignes que la personne n'a pas
        // le droit de voir — un refus révèle autant qu'une réponse (§104.7, `resoudre.ts`).
        resolues.push(texte);
        nonResolus.push({
          champ: ch.nom, texte,
          raison: `je ne sais pas désigner un « ${ch.modele} » par son nom : aucune portée de `
            + `lecture n'est déclarée pour cet objet, et chercher sans elle montrerait des lignes `
            + `hors de votre périmètre. Donnez l'identifiant`,
        });
        continue;
      }

      const r = await resoudreCible(user, def.name, texte);
      if (r.retenu.length === 1) {
        resolues.push(r.retenu[0]!.id);
        substitutions.push({ champ: ch.nom, texte, objet: def.label, cible: r.retenu[0]! });
        modifie = true;
        continue;
      }
      resolues.push(texte);
      const phrase = direRefus(r);
      if (phrase) refus.push(`« ${ch.nom} » : ${phrase}`);
    }

    if (modifie) sortie[ch.nom] = Array.isArray(brut) ? resolues : resolues[0];
  }

  return { entree: sortie, substitutions, refus, nonResolus };
}
