import type { OpImpl, OpProposalDraft } from "./types";
import {
  CONTRAT_PAR_ID, CONTRATS_ACTIONS, direContrat, chercherCapacites,
  interdictionGenerique, validerEntree, executerAction, relireApresEcriture, direEmpreinteEcriture,
  resoudreEntrees, champsDesignables, type ContratAction,
} from "@/platform/in-process/capacites";
import { OPS_CATALOG } from "./catalog";
import { ACTION_CLASSIFICATION } from "@/lib/assistant/action-registry";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CHEMIN GÉNÉRIQUE, BRANCHÉ — l'appelant de production que §118.14 exige.
 *
 * `contrat.ts` décrit 598 actions, `generique.ts` décide lesquelles sont ouvertes, `executer.ts`
 * les appelle. Tant que rien ne les DÉCLENCHE depuis une vraie conversation, les trois sont du
 * code mort : « si quelqu'un utilise Adam normalement maintenant, ce composant peut-il être
 * déclenché et produire un effet utile ? » Ce fichier est la réponse.
 *
 * ── UNE SEULE OP, ET LE REFUS FAIT LA DÉCOUVERTE ─────────────────────────────────────────
 *
 * Le plan prévoyait trois outils — chercher, décrire, exécuter. Ils coûteraient deux
 * aller-retours de modèle avant le moindre effet. Ici, `run` accepte AUSSI une intention en
 * français : quand elle ne désigne pas une action unique, le refus LISTE les candidates avec
 * leurs champs. C'est §118.30 poussé à sa conclusion — un refus qui nomme le remède remplace
 * l'outil qu'on aurait écrit pour l'éviter.
 *
 * ── CE QU'IL NE FAIT PAS ─────────────────────────────────────────────────────────────────
 *
 * Il ne DEVINE pas l'action : plusieurs correspondances n'en désignent AUCUNE (§118.34) — la
 * collapser exécuterait un geste à la place d'un humain. Il n'invente aucun champ, ne
 * contourne aucune porte (l'action revérifie tout), et refuse par CONSTRUCTION les gestes
 * d'auto-escalade, Super Admin compris.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MAX_CANDIDATES = 6;
/** Les refusées plus proches de la phrase que toute ouverte : celles-là portent leur raison. */
export const MAX_REFUSEES_DEVANT = 2;
/** Les autres refusées sont nommées par leur identifiant, et le reste est COMPTÉ. */
export const MAX_REFUSEES_NOMMEES = 8;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QU'UNE DÉCISION ÉCRITE A EXCLU DU CHAMP D'ADAM, LE CHEMIN GÉNÉRIQUE NE LE ROUVRE PAS
 * (§118.158).
 *
 * `ACTION_CLASSIFICATION` range chaque action serveur, et EXCLUDED y porte une décision ÉCRITE,
 * chacune avec sa raison : signer un BC est une attestation, publier sur le site public ne se
 * rattrape pas, usurper une identité appartient à la personne au clavier. Le chemin générique,
 * lui, ne lisait que ses trois faits (le fichier, le modèle écrit, les mots du nom). Mesuré :
 * **95 actions EXCLUDED sur 125 lui restaient OUVERTES** — dont `startImpersonation`,
 * `purgeSettledExpenseOrders`, les fiches de coaching, les décisions de plan de tournée, la
 * révocation d'un siège au centre de paiement et la publication sur le site. Chaque note
 * affirmait une chose que le code ne tenait pas, et c'est la publication sur le site qui l'a
 * montré : son propre en-tête écrivait « aucun de ces gestes n'est offert à Adam ».
 *
 * ── POURQUOI ICI ─────────────────────────────────────────────────────────────────────────
 *
 * Le registre vit côté Adam. Descendre la règle dans `actions/generique.ts` ferait lire à l'ERP
 * la politique d'Adam — une traversée à l'envers. Et c'est l'endroit où TOUTES les instances
 * passent (§118.58) : cette op est le seul appelant de production de `executerAction`, et un
 * banc l'exige. Réparer quatre-vingt-quinze notes une par une n'aurait pas protégé la
 * quatre-vingt-seizième.
 *
 * ── TROIS PORTES, ET L'EXÉCUTION RELIT ───────────────────────────────────────────────────
 *
 * La fiche (ce que le modèle lit), la proposition (la carte) et l'exécution. L'exécution relit
 * AVANT d'appeler l'action : une carte proposée avant ce correctif, ou des arguments forgés, ne
 * passent pas. Le refus CITE la décision, qui nomme l'écran où le geste se fait — refusé à Adam
 * n'est pas impossible, et le taire ferait répondre « je ne trouve rien » là où la vérité est
 * « je l'ai trouvée et je n'y touche pas » (§118.30, §118.74).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function refusDuCheminGenerique(c: ContratAction): string | null {
  const interdit = interdictionGenerique(c);
  if (interdit) return interdit;
  const classement = ACTION_CLASSIFICATION[c.id];
  if (classement?.status !== "EXCLUDED") return null;
  return `Cette action est tenue hors du champ d'Adam par une décision écrite : ${(classement.note ?? "").trim()} `
    + `C'est un refus de conception, pas une limite technique : le chemin générique ne s'y substitue pas.`;
}

/**
 * QUELLE OP DÉCLARÉE COUVRE CETTE ACTION ? — ce qui transforme une limite en ROUTE.
 *
 * Le chemin générique ne sait désigner par leur nom que les objets dont une PORTÉE de lecture
 * est déclarée (29 sur 310 modèles) : il ne trouvera jamais « le dossier Campagne » du Drive,
 * dont l'accès se calcule nœud par nœud et ne s'écrit pas en clause Prisma. Les ops de domaine,
 * elles, le font depuis toujours — `resolveDriveNode` interroge `resolveDriveAccess` pour chaque
 * nœud. Le refus les NOMME au lieu de s'arrêter à « donnez l'identifiant » : un refus qui nomme
 * la faute sans nommer le remède fait payer un aller-retour, et tue parfois la mission (§118.30).
 *
 * Et c'est la réponse mesurée à « le chemin générique remplace-t-il les 503 propose écrits à la
 * main ? » — non : il les COMPLÈTE, et chacun est le bon chemin là où il existe.
 */
const OPS_PAR_ACTION: ReadonlyMap<string, { tool: string; op: string; uiLabel: string }[]> = (() => {
  const m = new Map<string, { tool: string; op: string; uiLabel: string }[]>();
  for (const meta of OPS_CATALOG) {
    for (const cle of meta.covers) {
      m.set(cle, [...(m.get(cle) ?? []), { tool: meta.tool, op: meta.op, uiLabel: meta.uiLabel }]);
    }
  }
  return m;
})();

export const direOpsCouvrantes = (id: string): string => {
  const ops = OPS_PAR_ACTION.get(id) ?? [];
  if (ops.length === 0) return "";
  return ` L'op ${ops.map((o) => `\`${o.tool}/${o.op}\` (« ${o.uiLabel} »)`).join(" ou ")} `
    + `résout ce nom pour vous.`;
};

/** Ce que le modèle a écrit dans `champs` — du JSON, ou rien. */
function lireChamps(brut: string): { ok: true; champs: Record<string, unknown> } | { ok: false; erreur: string } {
  const t = brut.trim();
  if (!t) return { ok: true, champs: {} };
  try {
    const v = JSON.parse(t) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return { ok: false, erreur: "« champs » doit être un objet JSON, par exemple {\"name\":\"Oncologie 2027\"}." };
    }
    return { ok: true, champs: v as Record<string, unknown> };
  } catch {
    return { ok: false, erreur: `« champs » n'est pas du JSON valide : ${t.slice(0, 120)}` };
  }
}

/**
 * LA FICHE D'UNE ACTION, telle qu'un modèle et un humain la lisent tous les deux — et qui DIT
 * quels champs acceptent un nom. Sans cette phrase, « reference » se lit « donne-moi un
 * identifiant », et le modèle en invente un ou renonce (§118.19).
 */
const fiche = (c: ContratAction): string => {
  const interdit = refusDuCheminGenerique(c);
  if (interdit) return `${c.id} — REFUSÉE : ${interdit}`;
  const nommables = champsDesignables(c);
  const suffixe = nommables.length
    ? ` — vous pouvez écrire un NOM ou une référence pour ${nommables.map((n) => `${n.champ} (${n.objet})`).join(", ")}`
    : "";
  return `${direContrat(c)}${suffixe}`;
};

/**
 * DE CE QUE LE MODÈLE A ÉCRIT À UNE ACTION UNIQUE.
 *
 * Un identifiant exact tranche. Sinon on cherche, et l'on ne rend une action QUE si la
 * recherche en désigne une seule — sans quoi le refus montre les candidates.
 *
 * ── LES REFUSÉES NE PRENNENT PAS LES PLACES DES OUVERTES (§118.168) ──────────────────────
 *
 * La recherche coupait à six AVANT de savoir lesquelles sont ouvertes. Le stock promotionnel a
 * ajouté des actions dont le nom porte « demande », toutes tenues hors du champ d'Adam par une
 * décision écrite : à égalité de score, l'ordre alphabétique les a mises aux six premières
 * places, et « créer une demande » ne rendait plus QUE des refus — alors que
 * `admin-request-actions:createRequest`, ouverte, était trouvée. Un modèle qui lit six refus
 * conclut « je ne peux pas » : le défaut de §118.63, fabriqué par l'ajout d'actions qu'on avait
 * raison de refuser. Et l'en-tête disait « correspond à 6 actions » sur vingt-huit
 * correspondances : une coupe qui se lisait comme un compte (§118.60).
 *
 * On cherche donc TOUT, puis on sépare. Les fiches complètes vont aux OUVERTES : ce sont les
 * seules dont les champs servent au tour suivant. Les refusées restent NOMMÉES — les taire ferait
 * répondre « je ne trouve rien » là où la vérité est « je l'ai trouvée et je n'y touche pas »
 * (§118.74) — et celles que la phrase désigne MIEUX que toute ouverte passent devant, avec leur
 * raison et leur écran : « annuler la demande de matériel » désigne `annulerDemande`, refusée, et
 * la ranger derrière six gestes ouverts sans rapport pousserait le modèle vers le mauvais objet
 * (§104.7). Sans aucune ouverte, la réponse est la fiche des refus, comme avant. Ce qui n'est pas
 * montré est COMPTÉ, jamais coupé en silence.
 */
function designer(texte: string): { contrat: ContratAction } | { refus: string } {
  const q = texte.trim();
  if (!q) return { refus: "Précisez l'action : son identifiant « fichier:fonction », ou ce que vous voulez faire." };

  const exact = CONTRAT_PAR_ID.get(q);
  if (exact) return { contrat: exact };

  const trouves = chercherCapacites(CONTRATS_ACTIONS, q, Number.POSITIVE_INFINITY);
  if (trouves.length === 0) {
    return {
      refus: `Aucune action de l'ERP ne correspond à « ${q} ». Reformulez avec le geste et son objet `
        + `(« créer une demande administrative », « changer le statut d'un dossier »).`,
    };
  }
  if (trouves.length === 1) return { contrat: trouves[0]!.contrat };

  // PLUSIEURS N'EN DÉSIGNENT AUCUNE (§118.34). Le refus porte les fiches : le tour suivant
  // choisit ET connaît déjà les champs, donc il n'y a pas d'aller-retour supplémentaire.
  const ouvertes = trouves.filter((t) => refusDuCheminGenerique(t.contrat) === null);
  const refusees = trouves.filter((t) => refusDuCheminGenerique(t.contrat) !== null);
  const entete = `« ${q} » correspond à ${trouves.length} actions — précisez laquelle par son identifiant :`;
  const puce = (t: { contrat: ContratAction }) => `  • ${fiche(t.contrat)}`;
  const reste = (n: number, quoi: string) => (n > 0 ? [`  … et ${n} ${quoi}.`] : []);

  if (ouvertes.length === 0) {
    return {
      refus: [
        entete,
        ...refusees.slice(0, MAX_CANDIDATES).map(puce),
        ...reste(refusees.length - MAX_CANDIDATES, "autre(s), refusée(s) elles aussi"),
      ].join("\n"),
    };
  }

  const meilleureOuverte = ouvertes[0]!.score;
  const devant = refusees.filter((t) => t.score > meilleureOuverte).slice(0, MAX_REFUSEES_DEVANT);
  const autres = refusees.filter((t) => !devant.includes(t));
  const nommees = autres.slice(0, MAX_REFUSEES_NOMMEES).map((t) => t.contrat.id);
  return {
    refus: [
      entete,
      ...devant.map(puce),
      ...ouvertes.slice(0, MAX_CANDIDATES).map(puce),
      ...reste(ouvertes.length - MAX_CANDIDATES, "autre(s) action(s) ouverte(s), moins proches de la phrase : précisez le geste et son objet pour les voir"),
      ...(nommees.length > 0
        ? [`Trouvées aussi, mais tenues hors du champ d'Adam par conception (leur identifiant exact donne `
          + `la raison et l'écran où le geste se fait) : ${nommees.join(", ")}`
          + `${autres.length > nommees.length ? `, et ${autres.length - nommees.length} autre(s)` : ""}.`]
        : []),
    ].join("\n"),
  };
}

export const CAPABILITY_OPS_IMPL: Record<string, OpImpl> = {
  run: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const brut = typeof input.action === "string" ? input.action : "";
      const vise = designer(brut);
      if ("refus" in vise) return { error: vise.refus };
      const contrat = vise.contrat;

      // L'AUTO-ESCALADE d'abord : constater qu'une entrée est mal formée sur `updateUserRole`
      // reviendrait à dire « corrige ta saisie et réessaie » (§118.6).
      const interdit = refusDuCheminGenerique(contrat);
      if (interdit) return { error: interdit };

      const lus = lireChamps(typeof input.champs === "string" ? input.champs : "");
      if (!lus.ok) return { error: lus.erreur };

      const refus = validerEntree(contrat, lus.champs);
      if (refus.length > 0) {
        return { error: `${refus.map((r) => r.raison).join(" ")}\nCette action attend : ${fiche(contrat)}` };
      }

      // « NIVOLEX » LÀ OÙ L'ACTION ATTEND UN `cuid` — la désignation se fait ICI, dans la
      // proposition, et son résultat part dans les `args`. Résoudre à nouveau à l'exécution
      // pourrait désigner une AUTRE ligne entre la carte et le clic : ce qu'on confirme doit
      // être ce qui sera fait (§104.7).
      const cibles = await resoudreEntrees(user, contrat, lus.champs);
      if (cibles.refus.length > 0) {
        return { error: `${cibles.refus.join("\n")}${direOpsCouvrantes(contrat.id)}` };
      }

      const valeurs = Object.entries(cibles.entree).filter(([, v]) => v !== undefined && v !== null && v !== "");
      const parChamp = new Map(cibles.substitutions.map((sub) => [sub.champ, sub]));
      const montrer = (cle: string, v: unknown): string => {
        const sub = parChamp.get(cle);
        // CE QU'ON MONTRE EST LA LIGNE, PAS L'IDENTIFIANT : une carte qui affiche
        // `cmt9k…` demande de confirmer ce qu'on ne peut pas lire (§104.16).
        if (sub) {
          const suffixe = sub.cible.sousTitre ? ` — ${sub.cible.sousTitre}` : "";
          return `« ${sub.texte} » → ${sub.objet} : ${sub.cible.titre}${suffixe}`;
        }
        return Array.isArray(v) ? v.join(", ") : String(v);
      };
      return {
        title: `${contrat.fonction} — ${contrat.porte.moduleFr ?? contrat.fichier.replace(/-actions$/, "")}`,
        fields: [
          { label: "Action", value: contrat.id },
          ...valeurs.map(([k, v]) => ({ label: k, value: montrer(k, v) })),
        ],
        warnings: [
          // La carte DIT ce qui va être touché : c'est ce qu'on confirme, pas une trace qu'on
          // déplie après coup (§118.55).
          // LA PHRASE NOMME les objets métier en FRANÇAIS, compte les tables techniques et DIT
          // si quelqu'un sera prévenu — elle ne récite plus des noms de modèles Prisma, dont
          // deux sur trois n'étaient que le journal d'audit (§118.120).
          contrat.ecrit
            ? direEmpreinteEcriture(contrat.modelesEcrits)
            : "Aucune écriture en base détectée dans cette action.",
          // CE QU'ON N'A PAS SU DÉSIGNER SE DIT, avec le geste qui le lève : le silence d'une
          // fiche se lit comme une permission de deviner (§118.26, §118.30).
          ...cibles.nonResolus.map((n) =>
            `« ${n.champ} » a été transmis tel quel : ${n.raison}.${direOpsCouvrantes(contrat.id)}`),
          "Vos droits sont revérifiés par l'action elle-même, exactement comme au clic sur le bouton.",
        ],
        args: { action: contrat.id, champs: JSON.stringify(cibles.entree) },
        successMessage: `${contrat.fonction} exécutée.`,
      };
    },

    /**
     * APRÈS L'ÉCRITURE, ON RELIT — et si l'on ne peut pas, on le DIT.
     *
     * La première version rendait `« setRegulatoryPriority exécutée. »`. La personne n'avait
     * qu'une parole : rien ne lui permettait de constater ce qui avait changé. C'est ce que
     * §104.16 interdit — et le retour de l'action, qui porte l'identifiant écrit, était jeté.
     *
     * Trois phrases possibles, et JAMAIS « fait » tout court : ce qui a été constaté, ce qui
     * a été fait sans pouvoir être constaté, ou l'échec. La distinction compte plus que la
     * relecture elle-même : une action qui rend `ok` sans qu'on puisse rien relire reste un
     * succès ANNONCÉ, et l'annoncer comme vérifié serait le faux succès qu'on vient de fermer
     * ailleurs (§118.25).
     */
    async execute(args, user) {
      const id = args.action ?? "";
      const lus = lireChamps(args.champs ?? "");
      if (!lus.ok) return { ok: false, error: lus.erreur };
      // RELIRE AVANT D'APPELER : la carte a pu être proposée avant que la décision soit écrite,
      // ou les arguments forgés. `executerAction` ne connaît pas le registre d'Adam (§118.158).
      const vise = CONTRAT_PAR_ID.get(id);
      const exclu = vise ? refusDuCheminGenerique(vise) : null;
      if (exclu) return { ok: false, error: exclu };
      const r = await executerAction(user, id, lus.champs);
      if (!r.ok) return { ok: false, error: r.message };

      // Sur une action qui n'écrit rien, il n'y a rien à relire et ce n'est pas une lacune.
      if (!r.contrat.ecrit) return { ok: true, message: `${r.contrat.fonction} exécutée.` };

      const vu = await relireApresEcriture(user, r.contrat.modelesEcrits, lus.champs, r.retour)
        .catch(sansBloquer("impl-capabilite.execute.relireApresEcriture", null));
      if (!vu) {
        return {
          ok: true,
          message: `${r.contrat.fonction} exécutée. Je n'ai PAS pu relire la ligne pour vous la `
            + `montrer — l'écriture a bien eu lieu, mais je ne la constate pas d'ici.`,
        };
      }
      const apercu = vu.champs.slice(0, 12).map((c) => `${c.nom} : ${c.valeur}`).join(" · ");
      return {
        ok: true,
        message: `${r.contrat.fonction} exécutée, et relu dans votre périmètre — `
          + `${vu.libelle} ${vu.id} → ${apercu}`,
      };
    },
  },
};
