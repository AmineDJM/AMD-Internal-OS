import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { getCurrentUser } from "@/lib/session";
import { userCan, type Action, type Module } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { MODULE_LABELS } from "@/lib/labels";
import { sansBloquer } from "@/lib/journal";
import { CONTRAT_PAR_ID, CONTRATS_ACTIONS } from "@/lib/actions/contrat.genere";
import type { ContratAction } from "@/lib/actions/contrat";
import { interdictionGenerique, validerEntree } from "@/lib/actions/generique";
import { executerAction } from "@/lib/actions/executer";
import { classerGeste } from "@/lib/annulation/reversibilite";
import { resoudreEntrees } from "@/lib/cibles/resoudre-entrees";
import { deriverRegistre, libelleChamp, schemaDe, type Registre } from "@/platform/ia/capacites/registre";
import type { Capacite, OutilDecrit } from "@/platform/ia/capacites/types";
import { persistActionIntents } from "@/platform/ia/intentions/action-intents";
import { familleOuverte, refusFamille, type AccesIa } from "../domaine/acces-regles";
import {
  estChargeCapacite, KIND_CAPACITE, niveauDeCarte, sortieBornee, texteARessaisir, valeurAffichee, type ChargeCapacite,
} from "../domaine/capacites";
import { encadrerNonFiable } from "../domaine/contenu-non-fiable";
import type { ResultatOperation } from "../domaine/operations/types";
import { REFUS_ARRET_URGENCE, REFUS_SECONDE_CARTE, type PropositionCarte } from "./operations";
import { auNomDe } from "./consommation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CAPACITÉS DE L'ERP, POUR L'ASSISTANT IA (lot J6, décision 0020) — le registre, branché.
 *
 * Le registre (`platform/ia/capacites/`) est PUR ; ici, il reçoit le contrat des actions (`contrat.genere.json`) et
 * ses trois ports (le refus générique, la table d'annulation, les modules RBAC), puis devient des OUTILS :
 *
 *   • OFFERT seulement si la PORTE de l'écran est ouverte à la personne (`porteOuverte`) : la sélection ne voit jamais
 *     une capacité hors droits — la porte n'autorise rien pour autant, l'action rejuge tout à l'exécution ;
 *   • la FAMILLE de la console est rejugée à la préparation ET à la confirmation (relue en base) ;
 *   • R0 : l'action s'exécute pendant le tour, sous la session de la personne (elle seule : une autre session, ou
 *     aucune — une reprise de fond — refuse), sortie bornée et encadrée si elle porte un contenu tiers ;
 *   • R1+ : une CARTE (intention persistée, une par tour), renforcée en R3/R4 (ressaisie) ; à la confirmation,
 *     `executerCapacite` rejuge l'arrêt d'urgence, la porte, la famille et l'entrée, puis appelle L'ACTION ELLE-MÊME
 *     (`executerAction`) — la vraie session est celle de la requête de confirmation.
 *
 * Rien n'est déclaré à la main : une action ajoutée à l'ERP arrive ici par `npm run actions:contrat`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let registre: Registre | null = null;

/** LE REGISTRE DES ACTIONS ET DE L'ATELIER (une fois par processus) ; les outils du module s'y ajoutent à la demande. */
export function registreDesCapacites(outils: readonly OutilDecrit[] = []): Registre {
  if (!outils.length && registre) return registre;
  const r = deriverRegistre(CONTRATS_ACTIONS, { interdiction: interdictionGenerique, classerGeste, modules: MODULE_LABELS }, outils);
  if (!outils.length) registre = r;
  return r;
}

/** LA PORTE D'ÉCRAN : l'un des modules de la capacité est ouvert à la personne (Super Admin : tout). */
export function porteOuverte(user: CurrentUser, cap: Capacite): boolean {
  if (user.role === "SUPER_ADMIN") return true;
  if (cap.superAdminSeul || cap.modules.length === 0) return false;
  const verbe = (cap.verbe ?? "VIEW") as Action;
  return cap.modules.some((m) => userCan(user, m as Module, verbe));
}

/** Les capacités d'actions OFFERTES à cette personne : appelables, porte ouverte. */
export function capacitesOffertes(user: CurrentUser): Capacite[] {
  return registreDesCapacites().capacites.filter((c) => c.source === "action" && c.appelable && porteOuverte(user, c));
}

const refusFamilleDe = (cap: Capacite, acces: AccesIa): string | null => {
  const fermee = cap.familles.find((f) => !familleOuverte(acces, f));
  return fermee ? refusFamille(fermee) : null;
};

/** L'entrée du modèle, nettoyée : seuls les champs du contrat, sans vide. */
function entreeNettoyee(cap: Capacite, brute: Record<string, unknown>): Record<string, unknown> {
  const connus = new Set(CONTRAT_PAR_ID.get(cap.id)?.champs.map((c) => c.nom) ?? []);
  return Object.fromEntries(Object.entries(brute ?? {}).filter(([k, v]) => connus.has(k) && v !== undefined && v !== null && v !== ""));
}

/** Préparer : résoudre les noms (sous la portée de la personne), valider contre le contrat. */
/**
 * UNE PERSONNE DÉSIGNÉE PAR SON NOM, même quand le schéma ne le dit pas : `task-actions:createTask` porte `assignedToId`
 * sans modèle lu. Un champ de référence SANS modèle dont le nom désigne une personne (assigné, responsable, validateur…)
 * se résout par l'annuaire, comme un champ `User` — plusieurs homonymes n'en désignent aucun (`resoudreEntrees`).
 */
const NOM_DE_PERSONNE = /^(user|assigned|assignee|responsible|manager|validator|owner|recipient|participant|reader|member|decideur|collaborator|standIn|person|personne|productManager|assistant)/i;
const avecPersonnes = (c: ContratAction): ContratAction => ({
  ...c,
  champs: c.champs.map((ch) => (!ch.modele && (ch.type === "reference" || ch.type === "liste") && NOM_DE_PERSONNE.test(ch.nom) && /Ids?$/.test(ch.nom) ? { ...ch, modele: "User" } : ch)),
});

async function preparer(user: CurrentUser, cap: Capacite, brute: Record<string, unknown>) {
  const lu = CONTRAT_PAR_ID.get(cap.id);
  if (!lu) return { refus: `L'action « ${cap.id} » n'existe plus dans l'ERP.` } as const;
  const contrat = avecPersonnes(lu);
  const r = await resoudreEntrees(user, contrat, entreeNettoyee(cap, brute));
  if (r.refus.length) return { refus: r.refus.join(" ") } as const;
  // Un nom resté dans un champ d'identifiant ferait agir sur rien (ou sur la mauvaise ligne) : on le demande.
  if (r.nonResolus.some((n) => contrat.champs.find((c) => c.nom === n.champ)?.type === "reference")) {
    return { incomplet: r.nonResolus.map((n) => `« ${n.champ} » : ${n.raison}`) } as const;
  }
  const fautes = validerEntree(contrat, r.entree);
  if (fautes.length) return { incomplet: fautes.map((f) => f.raison) } as const;
  return { entree: r.entree, affichage: new Map(r.substitutions.map((s) => [s.champ, s.cible.titre])) } as const;
}

const json = (o: unknown) => JSON.stringify(o);

/** La DÉFINITION d'une capacité (nom, description, schéma) : fixe, calculée une fois — le même objet d'un tour à l'autre. */
const DEFINITIONS = new Map<string, PowerTool["def"]>();
const definitionDe = (cap: Capacite): PowerTool["def"] => {
  let d = DEFINITIONS.get(cap.id);
  if (!d) {
    d = { name: cap.outil, description: cap.description, input_schema: schemaDe(cap) as PowerTool["def"]["input_schema"] };
    DEFINITIONS.set(cap.id, d);
  }
  return d;
};

/** UN OUTIL PAR CAPACITÉ — son nom, son schéma tiré du contrat, sa porte, sa famille, son chemin (lecture ou carte). */
function outilDe(cap: Capacite, user: CurrentUser, propositions: PropositionCarte[], acces: AccesIa): PowerTool {
  return {
    def: definitionDe(cap),
    allowed: (u) => u.id === user.id && porteOuverte(u, cap),
    label: cap.risque === "R0" ? `${cap.libelle} (lu)` : `${cap.libelle} (préparé)`,
    run: async (brute, u) => {
      if (u.id !== user.id) return json({ statut: "REFUS", raison: "Cet outil a été préparé pour une autre personne." });
      const famille = refusFamilleDe(cap, acces);
      if (famille) return json({ statut: "REFUS", raison: famille });
      const p = await preparer(u, cap, brute ?? {});
      if ("refus" in p) return json({ statut: "REFUS", raison: p.refus });
      if ("incomplet" in p) return json({ statut: "INCOMPLET", manque: p.incomplet, consigne: "Pose UNE question à l'utilisateur pour obtenir ce qui manque ; n'invente aucune valeur." });

      if (cap.risque === "R0") {
        // LA SESSION DE LA PERSONNE, ET ELLE SEULE : l'action lit sa session (`requireUser`) ; une reprise de fond n'en a pas.
        const session = await getCurrentUser().catch(sansBloquer("capacites.lecture.session", null));
        if (!session || session.id !== u.id) {
          return json({ statut: "REFUS", raison: "Cette lecture s'exécute dans votre session ouverte : reposez la question depuis l'écran de l'assistant." });
        }
        const r = await executerAction(u, cap.id, p.entree);
        if (!r.ok) return json({ statut: "REFUS", raison: r.message });
        const sortie = sortieBornee(r.retour);
        return cap.contenuTiers ? encadrerNonFiable(cap.libelle, sortie) : sortie;
      }

      if (propositions.length > 0) return REFUS_SECONDE_CARTE;
      const contrat = CONTRAT_PAR_ID.get(cap.id)!;
      const fields = contrat.champs.filter((c) => p.entree[c.nom] !== undefined)
        .map((c) => ({ label: libelleChamp(c.nom), value: p.affichage.get(c.nom) ?? valeurAffichee(p.entree[c.nom]) }));
      const level = niveauDeCarte(cap.risque);
      const confirmText = level === "CRITICAL" ? texteARessaisir(cap.libelle, p.entree) : undefined;
      const warnings = [
        `${cap.raisonRisque.charAt(0).toUpperCase()}${cap.raisonRisque.slice(1)}.`,
        cap.annulation === "aucune" ? "Ce geste ne se défait pas." : `Annulation : ${cap.raisonAnnulation}.`,
      ];
      const charge: ChargeCapacite = { kind: KIND_CAPACITE, id: cap.id, entree: p.entree };
      const [intentId] = await persistActionIntents(u.id, [{
        kind: KIND_CAPACITE, module: cap.modules[0] ?? "ASSISTANT_IA", title: cap.libelle, fields,
        ...(level ? { level } : {}), ...(confirmText ? { confirmText } : {}), payload: charge,
      }], "text");
      if (!intentId) return json({ statut: "ECHEC", raison: "La proposition n'a pas pu être enregistrée." });
      propositions.push({ intentId, proposition: { kind: KIND_CAPACITE, title: cap.libelle, fields, warnings, ...(level ? { level } : {}), ...(confirmText ? { confirmText } : {}), payload: charge } });
      return json({
        statut: "EN_ATTENTE_DE_CONFIRMATION",
        titre: cap.libelle,
        champs: fields,
        avertissements: warnings,
        consigne: `Rien n'est exécuté : une carte de confirmation est affichée${confirmText ? ` — la personne devra ressaisir « ${confirmText} »` : ""}. Ne dis pas que c'est fait.`,
      });
    },
  };
}

/** LES OUTILS DE CAPACITÉ du tour — un par capacité offerte ; seuls ceux que la sélection active partent au modèle. */
export function outilsCapacites(user: CurrentUser, propositions: PropositionCarte[], acces: AccesIa): PowerTool[] {
  return capacitesOffertes(user).map((c) => outilDe(c, user, propositions, acces));
}

/** Les mots de recherche d'une capacité offerte, par nom d'outil — la sélection les lit (dérivés, jamais écrits à la main). */
export function motsDesCapacites(): ReadonlyMap<string, { mots: string; contexte: string }> {
  return new Map(registreDesCapacites().capacites.filter((c) => c.source === "action").map((c) => [c.outil, { mots: c.mots, contexte: c.contexte }]));
}

/**
 * EXÉCUTER une capacité confirmée — appelé SEULEMENT par la confirmation de l'Assistant IA, sous la réclamation
 * atomique de l'intention, dans la requête (donc la session) de la personne qui confirme.
 */
export async function executerCapacite(user: CurrentUser, charge: unknown, acces: AccesIa): Promise<ResultatOperation> {
  if (!estChargeCapacite(charge)) return { ok: false, error: "Action inconnue." };
  const reglages = await getAppSettings().catch(sansBloquer("capacites.executer.getAppSettings", null));
  if (reglages?.aiExternalActionsDisabled) return { ok: false, error: REFUS_ARRET_URGENCE };
  const cap = registreDesCapacites().parId.get(charge.id);
  if (!cap || !cap.appelable || cap.risque === "R0") return { ok: false, error: cap?.refus ?? "Cette action n'est plus appelable par l'assistant." };
  if (!porteOuverte(user, cap)) return { ok: false, error: "Vous n'avez plus accès à l'écran de ce geste." };
  const famille = refusFamilleDe(cap, acces);
  if (famille) return { ok: false, error: famille };
  const r = await auNomDe(user.id, () => executerAction(user, cap.id, charge.entree));
  return r.ok ? { ok: true, message: `${cap.libelle} : fait.` } : { ok: false, error: r.message };
}

export { estChargeCapacite };
