import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { getCurrentUser } from "@/lib/session";
import { userCan, type Action, type Module } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { MODULE_LABELS } from "@/lib/labels";
import { sansBloquer } from "@/lib/journal";
import { CONTRAT_PAR_ID, CONTRATS_ACTIONS } from "@/lib/actions/contrat.genere";
import { contratVuParLAssistantIa, interdictionDeLAssistantIa, validerEntree } from "@/lib/actions/generique";
import { prisma } from "@/lib/prisma";
import { executerAction } from "@/lib/actions/executer";
import { classerGeste } from "@/lib/annulation/reversibilite";
import { candidatsDuChamp, resoudreEntrees } from "@/lib/cibles/resoudre-entrees";
import { avecPersonnes, deriverRegistre, libelleChamp, schemaDe, zodDe, type Registre } from "@/platform/ia/capacites/registre";
import { formulaireDe, type FormulaireCarte } from "@/platform/ia/capacites/formulaire";
import { CHAMP_SALAIRE } from "@/platform/ia/capacites/classement";
import type { Capacite, OutilDecrit } from "@/platform/ia/capacites/types";
import { intentSummary, persistActionIntents } from "@/platform/ia/intentions/action-intents";
import { journaliserGeste, simulerEnDiff } from "@/platform/ia/hors-requete";
import { familleOuverte, refusFamille, type AccesIa } from "../domaine/acces-regles";
import {
  estChargeCapacite, KIND_CAPACITE, niveauDeCarte, sortieBornee, texteARessaisir, valeurAffichee, type ChargeCapacite,
} from "../domaine/capacites";
import { encadrerNonFiable } from "../domaine/contenu-non-fiable";
import { ecartAvecLaCarte, lireVueSimulation, vueDeCarte, vueNonSimulable, type VueSimulation } from "../domaine/simulation";
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
 *     (`executerAction`) — la vraie session est celle de la requête de confirmation ;
 *   • J7 (décision 0029) : une capacité SIMULABLE est jouée dans une transaction annulée AVANT la carte, qui montre le
 *     diff réel ; à la confirmation, la simulation est REJOUÉE et son empreinte comparée — un écart, et rien ne
 *     s'exécute (la carte se remontre) ; l'exécution réelle va au JOURNAL DES EFFETS (valeur avant de chaque champ).
 *
 * Rien n'est déclaré à la main : une action ajoutée à l'ERP arrive ici par `npm run actions:contrat`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LE CONTRAT VU PAR L'ASSISTANT IA — celui de l'ERP, moins les champs que l'assistant ne remplit jamais
 * (`GESTES_DE_FICHE` : le rattachement d'une fiche à un compte reste un geste d'écran).
 */
const CONTRATS_IA = CONTRATS_ACTIONS.map(contratVuParLAssistantIa);
const CONTRAT_IA = new Map(CONTRATS_IA.map((c) => [c.id, c]));

let registre: Registre | null = null;

/** LE REGISTRE DES ACTIONS ET DE L'ATELIER (une fois par processus) ; les outils du module s'y ajoutent à la demande. */
export function registreDesCapacites(outils: readonly OutilDecrit[] = []): Registre {
  if (!outils.length && registre) return registre;
  const r = deriverRegistre(CONTRATS_IA, { interdiction: interdictionDeLAssistantIa, classerGeste, modules: MODULE_LABELS }, outils);
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

/** Les familles de la console : celles de la capacité, et « Salaires & paie » dès que l'entrée touche une rémunération. */
const refusFamilleDe = (cap: Capacite, acces: AccesIa, entree: Readonly<Record<string, unknown>> = {}): string | null => {
  const salaire = !cap.familles.includes("SALAIRES") && Object.keys(entree).some((k) => CHAMP_SALAIRE.test(k));
  const fermee = [...cap.familles, ...(salaire ? ["SALAIRES" as const] : [])].find((f) => !familleOuverte(acces, f));
  return fermee ? refusFamille(fermee) : null;
};

/** L'entrée du modèle, nettoyée : seuls les champs du contrat, sans vide. */
function entreeNettoyee(cap: Capacite, brute: Record<string, unknown>): Record<string, unknown> {
  const connus = new Set(CONTRAT_IA.get(cap.id)?.champs.map((c) => c.nom) ?? []);
  return Object.fromEntries(Object.entries(brute ?? {}).filter(([k, v]) => connus.has(k) && v !== undefined && v !== null && v !== ""));
}

/** Préparer : résoudre les noms (sous la portée de la personne), valider contre le contrat. */
async function preparer(user: CurrentUser, cap: Capacite, brute: Record<string, unknown>) {
  const lu = CONTRAT_IA.get(cap.id);
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

/**
 * CE QUE LA CARTE MONTRE d'une entrée préparée : les champs lus (le résumé), le niveau, la ressaisie, et le FORMULAIRE
 * généré depuis le contrat (J11, décision 0030) — la proposition pré-remplie, les références nommées.
 */
function carteDe(cap: Capacite, entree: Record<string, unknown>, affichage: ReadonlyMap<string, string>) {
  const contrat = CONTRAT_IA.get(cap.id)!;
  const fields = contrat.champs.filter((c) => entree[c.nom] !== undefined)
    .map((c) => ({ label: libelleChamp(c.nom), value: affichage.get(c.nom) ?? valeurAffichee(entree[c.nom]) }));
  const level = niveauDeCarte(cap.risque);
  const confirmText = level === "CRITICAL" ? texteARessaisir(cap.libelle, entree) : undefined;
  // Une référence résolue par son nom garde ce nom à l'écran (l'identifiant seul ne dit rien à la personne).
  const etiquettes: Record<string, string> = {};
  for (const [champ, titre] of affichage) {
    const v = entree[champ];
    if (typeof v === "string") etiquettes[v] = titre;
  }
  const formulaire: FormulaireCarte = formulaireDe(cap.id, cap.champs, entree, etiquettes);
  return { fields, level, confirmText, formulaire };
}

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
        const r = await executerAction(u, cap.id, p.entree, "assistant-ia");
        if (!r.ok) return json({ statut: "REFUS", raison: r.message });
        const sortie = sortieBornee(r.retour);
        return cap.contenuTiers ? encadrerNonFiable(cap.libelle, sortie) : sortie;
      }

      const salaire = refusFamilleDe(cap, acces, p.entree);
      if (salaire) return json({ statut: "REFUS", raison: salaire });
      if (propositions.length > 0) return REFUS_SECONDE_CARTE;
      const { fields, level, confirmText, formulaire } = carteDe(cap, p.entree, p.affichage);
      const warnings = [
        `${cap.raisonRisque.charAt(0).toUpperCase()}${cap.raisonRisque.slice(1)}.`,
        cap.annulation === "aucune" ? "Ce geste ne se défait pas." : `Annulation : ${cap.raisonAnnulation}.`,
      ];
      // LA SIMULATION (J7) : le diff RÉEL de l'action, jouée dans une transaction annulée — ou « non simulable », dit.
      const simulation = cap.simulable === "oui" ? await simulerLaCapacite(u, cap, p.entree) : vueNonSimulable(cap.raisonSimulable);
      if (simulation.statut === "ECHEC") warnings.unshift(`La simulation n'a pas abouti : ${simulation.raison ?? "raison inconnue"}. Confirmer exécutera quand même l'action, qui revérifiera tout.`);
      const charge: ChargeCapacite = { kind: KIND_CAPACITE, id: cap.id, entree: p.entree, simulation };
      const [intentId] = await persistActionIntents(u.id, [{
        kind: KIND_CAPACITE, module: cap.modules[0] ?? "ASSISTANT_IA", title: cap.libelle, fields,
        ...(level ? { level } : {}), ...(confirmText ? { confirmText } : {}), payload: charge,
      }], "text");
      if (!intentId) return json({ statut: "ECHEC", raison: "La proposition n'a pas pu être enregistrée." });
      propositions.push({ intentId, proposition: { kind: KIND_CAPACITE, title: cap.libelle, fields, warnings, simulation, formulaire, ...(level ? { level } : {}), ...(confirmText ? { confirmText } : {}), payload: charge } });
      return json({
        statut: "EN_ATTENTE_DE_CONFIRMATION",
        titre: cap.libelle,
        champs: fields,
        avertissements: warnings,
        simulation: simulation.resume,
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
 * LES ACTIONS QUI REMPLACENT LA FICHE ENTIÈRE — `updateEmployee` relit tout le formulaire : un champ absent y devient
 * vide (salaire à 0, compte délié, fiche inactive). La carte ne porte que ce que la personne change ; à la
 * confirmation, la fiche est RELUE et rejouée sous ces changements (le département, lui, reste inchangé quand le
 * formulaire n'en parle pas). Relue au dernier moment : une correction faite entre-temps à l'écran n'est pas écrasée.
 */
const FUSIONS: Readonly<Record<string, (id: string) => Promise<Record<string, unknown> | null>>> = {
  "hr-actions:updateEmployee": (id) => prisma.employee.findUnique({ where: { id } }),
};
const NON_REJOUES = new Set(["department", "departmentId"]);

const valeurRejouee = (v: unknown): unknown =>
  v instanceof Date ? v.toISOString().slice(0, 10)
    : v && typeof v === "object" && "toNumber" in v ? (v as { toNumber: () => number }).toNumber() : v;

async function fusionnee(id: string, entree: Record<string, unknown>): Promise<Record<string, unknown>> {
  const lire = FUSIONS[id];
  const cible = entree.id;
  if (!lire || typeof cible !== "string") return entree;
  const fiche = await lire(cible);
  if (!fiche) return entree;
  const rejoue: Record<string, unknown> = {};
  for (const ch of CONTRAT_PAR_ID.get(id)?.champs ?? []) {
    const v = fiche[ch.nom];
    if (!NON_REJOUES.has(ch.nom) && v !== null && v !== undefined && v !== false) rejoue[ch.nom] = valeurRejouee(v);
  }
  return { ...rejoue, ...entree };
}

/**
 * LA SIMULATION D'UNE CAPACITÉ (J7) — l'action elle-même, avec l'entrée qui serait exécutée (la fiche relue pour
 * `updateEmployee`), au nom de la personne, dans une transaction annulée. Rend ce que la carte montre.
 */
async function simulerLaCapacite(user: CurrentUser, cap: Capacite, entree: Record<string, unknown>): Promise<VueSimulation> {
  const complete = await fusionnee(cap.id, entree);
  const { diff } = await simulerEnDiff(user, { origine: "carte" }, () => executerAction(user, cap.id, complete, "assistant-ia"), (r) => (r.ok ? null : r.message));
  return vueDeCarte(diff);
}

/** La carte, remontrée avec le diff de ce qui s'exécuterait MAINTENANT (la confirmation suivante le comparera). */
async function remontrerLaCarte(intentId: string, simulation: VueSimulation): Promise<void> {
  const i = await prisma.assistantActionIntent.findUnique({ where: { id: intentId }, select: { payload: true } });
  const payload = (i?.payload && typeof i.payload === "object" ? i.payload : {}) as Record<string, unknown>;
  await prisma.assistantActionIntent.update({ where: { id: intentId }, data: { payload: { ...payload, simulation } as never } });
}

/**
 * EXÉCUTER une capacité confirmée — appelé SEULEMENT par la confirmation de l'Assistant IA, sous la réclamation
 * atomique de l'intention, dans la requête (donc la session) de la personne qui confirme.
 */
export async function executerCapacite(user: CurrentUser, charge: unknown, acces: AccesIa, intentId: string | null = null): Promise<ResultatOperation> {
  if (!estChargeCapacite(charge)) return { ok: false, error: "Action inconnue." };
  const reglages = await getAppSettings().catch(sansBloquer("capacites.executer.getAppSettings", null));
  if (reglages?.aiExternalActionsDisabled) return { ok: false, error: REFUS_ARRET_URGENCE };
  const cap = registreDesCapacites().parId.get(charge.id);
  if (!cap || !cap.appelable || cap.risque === "R0") return { ok: false, error: cap?.refus ?? "Cette action n'est plus appelable par l'assistant." };
  if (!porteOuverte(user, cap)) return { ok: false, error: "Vous n'avez plus accès à l'écran de ce geste." };
  const famille = refusFamilleDe(cap, acces, charge.entree);
  if (famille) return { ok: false, error: famille };
  // Les champs retenus ne passent jamais, même glissés dans une charge : seuls ceux du contrat de l'assistant.
  const connus = new Set(CONTRAT_IA.get(cap.id)?.champs.map((c) => c.nom) ?? []);
  const entree = await fusionnee(cap.id, Object.fromEntries(Object.entries(charge.entree).filter(([k]) => connus.has(k))));
  // CE QUI S'EXÉCUTE EST CE QUE LA CARTE A MONTRÉ (J7) : la simulation rejouée, son empreinte comparée.
  const montree = lireVueSimulation(charge.simulation);
  if (montree?.statut === "SIMULE") {
    const rejouee = await simulerLaCapacite(user, cap, charge.entree);
    const ecart = ecartAvecLaCarte(montree, rejouee);
    if (ecart) {
      if (intentId) await remontrerLaCarte(intentId, rejouee).catch(sansBloquer("capacites.remontrer"));
      return { ok: false, error: `Rien n'a été exécuté : ${ecart} Relisez, puis confirmez de nouveau si c'est toujours ce que vous voulez.` };
    }
  }
  const { resultat: r, ecart } = await journaliserGeste(user, {
    origine: "carte", capaciteId: cap.id, libelle: cap.libelle, cleIdempotence: intentId,
    empreinteSimulee: montree?.statut === "SIMULE" ? montree.empreinte : null,
  }, () => auNomDe(user.id, () => executerAction(user, cap.id, entree, "assistant-ia")));
  if (!r.ok) return { ok: false, error: r.message };
  return { ok: true, message: `${cap.libelle} : fait.${ecart ? " Attention : l'écriture réelle diffère de la simulation montrée (le monde a changé entre-temps) — voyez « Ce que l'assistant a fait »." : ""}` };
}

// ─────────────────────────────── LE FORMULAIRE DE LA CARTE (J11, décision 0030) ───────────────────────────────

/** La carte encore à signer de CETTE personne, et la capacité qu'elle porte — sinon la raison. */
async function carteASigner(user: CurrentUser, intentId: string) {
  if (typeof intentId !== "string" || !intentId || intentId.length > 64) return { refus: "Carte introuvable." } as const;
  const i = await prisma.assistantActionIntent.findFirst({
    where: { id: intentId, userId: user.id }, select: { id: true, status: true, payload: true, events: true },
  });
  if (!i) return { refus: "Carte introuvable." } as const;
  if (i.status !== "PROPOSED") return { refus: "Cette carte n'est plus à signer : elle a déjà été traitée." } as const;
  if (!estChargeCapacite(i.payload)) return { refus: "Cette carte ne se corrige pas : confirmez-la ou redemandez-la." } as const;
  const cap = registreDesCapacites().parId.get(i.payload.id);
  if (!cap || !cap.appelable || cap.risque === "R0") return { refus: cap?.refus ?? "Cette action n'est plus appelable par l'assistant." } as const;
  if (!porteOuverte(user, cap)) return { refus: "Vous n'avez plus accès à l'écran de ce geste." } as const;
  return { intent: i, charge: i.payload, cap } as const;
}

/**
 * LA CORRECTION de la personne, avant sa signature : l'entrée saisie dans le formulaire REMPLACE la proposition de
 * l'assistant. Elle repasse par les MÊMES portes que la proposition — champs du contrat seuls, schéma zod du registre,
 * noms résolus sous la portée de la personne, contrat validé, familles de la console — puis la carte est réécrite
 * (charge, résumé, ressaisie recalculée : un montant corrigé se ressaisit corrigé). L'exécution reste celle de toute
 * carte : `executerIntention`, juste après, dans la même requête.
 */
export async function corrigerCarteCapacite(
  user: CurrentUser, intentId: string, saisie: unknown, acces: AccesIa,
): Promise<{ ok: true; confirmText: string | null } | { ok: false; error: string }> {
  const c = await carteASigner(user, intentId);
  if ("refus" in c) return { ok: false, error: c.refus ?? "Carte introuvable." };
  if (!saisie || typeof saisie !== "object" || Array.isArray(saisie)) return { ok: false, error: "Formulaire illisible." };
  const connus = new Set(c.cap.champs.map((ch) => ch.nom));
  const brute = Object.fromEntries(Object.entries(saisie as Record<string, unknown>).filter(([k, v]) => connus.has(k) && v !== undefined && v !== null && v !== ""));
  const z = zodDe(c.cap).safeParse(brute);
  if (!z.success) {
    const champs = [...new Set(z.error.issues.map((i) => libelleChamp(String(i.path[0] ?? ""))))].filter(Boolean);
    return { ok: false, error: `Formulaire incomplet ou invalide${champs.length ? ` : ${champs.join(", ")}` : ""}. Rien n'a été exécuté.` };
  }
  const famille = refusFamilleDe(c.cap, acces, brute);
  if (famille) return { ok: false, error: famille };
  const p = await preparer(user, c.cap, brute);
  if ("refus" in p) return { ok: false, error: `${p.refus} Rien n'a été exécuté.` };
  if ("incomplet" in p) return { ok: false, error: `${(p.incomplet ?? []).join(" ; ")}. Rien n'a été exécuté.` };
  const { fields, confirmText } = carteDe(c.cap, p.entree, p.affichage);
  const charge: ChargeCapacite = { kind: KIND_CAPACITE, id: c.cap.id, entree: p.entree };
  const corriges = Object.keys({ ...c.charge.entree, ...p.entree }).filter((k) => JSON.stringify(c.charge.entree[k] ?? null) !== JSON.stringify(p.entree[k] ?? null));
  const events = [...(Array.isArray(c.intent.events) ? c.intent.events : []), { status: "CORRECTED", at: new Date().toISOString(), champs: corriges }];
  // La réécriture n'a lieu QUE si la carte est toujours à signer (une seconde fenêtre l'a peut-être confirmée).
  const n = await prisma.assistantActionIntent.updateMany({
    where: { id: c.intent.id, userId: user.id, status: "PROPOSED" },
    data: {
      payload: charge as object, events: events as object[],
      summary: intentSummary({ kind: KIND_CAPACITE, module: c.cap.modules[0] ?? "ASSISTANT_IA", title: c.cap.libelle, fields, payload: charge }),
      ...(confirmText ? { confirmText } : {}),
    },
  });
  if (n.count !== 1) return { ok: false, error: "Cette carte n'est plus à signer : elle a déjà été traitée." };
  return { ok: true, confirmText: confirmText ?? null };
}

/**
 * LE SÉLECTEUR D'UNE RÉFÉRENCE du formulaire : seulement pour un champ de CETTE carte, seulement des fiches que la
 * personne voit (l'annuaire pour une personne, la portée de l'écran pour le reste — `candidatsDuChamp`).
 */
export async function chercherReferenceDeCarte(
  user: CurrentUser, intentId: string, champ: string, texte: string,
): Promise<{ ok: true; options: { id: string; titre: string; sousTitre: string | null }[] } | { ok: false; error: string }> {
  const c = await carteASigner(user, intentId);
  if ("refus" in c) return { ok: false, error: c.refus ?? "Carte introuvable." };
  const ch = c.cap.champs.find((x) => x.nom === champ);
  if (!ch?.modele) return { ok: false, error: "Ce champ ne désigne pas une fiche." };
  const options = await candidatsDuChamp(user, ch.modele, String(texte ?? ""));
  return { ok: true, options: options.slice(0, 8) };
}

export { estChargeCapacite };
