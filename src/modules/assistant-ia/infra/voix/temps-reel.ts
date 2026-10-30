import type { CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA, REFUS_ASSISTANT_IA } from "@/lib/rbac";
import type { PowerTool } from "@/platform/ia/outil";
import { modeleSttTerrain, modeleTempsReel } from "@/platform/ia/modeles-roles";
import { ouvrirSessionTempsReel, type OutilTempsReel, type SessionAccordee } from "@/platform/ia/voix/session-temps-reel";
import { compileContext } from "../contexte";
import { accesAssistantIa, getRoleConfig, resoudreConsignesRole, Revelateur } from "../role-config";
import { consigneFamilles, type AccesIa } from "../../domaine/acces-regles";
import { consigneGestesFermes, outilsV1, type PropositionPreparee } from "../outils-v1";
import { fichesOffertes, selectionDuTour } from "../selection";
import { CONSIGNE_SELECTION, OUTIL_TROUVER, SOCLE_OUTILS } from "../../domaine/selection-outils";
import { CoffretDuTour, reperesDe } from "../../domaine/filtre-confidentialite";
import { CONSIGNES_VOIX, outilInterditALaVoix, pourLaVoix } from "../../domaine/terrain/voix";
import { appelVoix, auNomDe, budgetDeLAppel, fermerBudget } from "../consommation";
import { cleFournisseurVoix } from "../modele";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX TEMPS RÉEL DE L'ASSISTANT IA (lot J13, décision 0025) — les MÊMES outils, droits et repères que le texte.
 *
 *   • OUVRIR : la porte de l'Assistant IA (`peutUtiliserAssistantIA`), la console d'accès relue, le plafond du jour,
 *     puis un secret éphémère (socle `platform/ia/voix/`). La session reçoit le SOCLE des outils de la personne
 *     (filtré par ses droits et la configuration de son rôle), `trouver_outil` et `utiliser_outil` — le même choix à la
 *     demande que le texte (J4), parce que le contexte vocal se paie en latence.
 *   • EXÉCUTER : chaque appel d'outil revient ICI. Les outils sont reconstruits sous les droits RELUS (console comprise) ;
 *     les valeurs sensibles restent des repères dans ce que la voix reçoit (`pourLaVoix` : « affichée à l'écran ») et ne
 *     sont révélées qu'à l'écran, à qui a le droit. Une écriture ne rend qu'une CARTE, affichée ; aucun outil de
 *     confirmation n'existe pour la voix (R3/R4 : la ressaisie de la carte vaut aussi).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const OUTIL_UTILISER = "utiliser_outil";
export const VOIX_ASSISTANT = (process.env.ASSISTANT_IA_REALTIME_VOICE || "marin").trim();

interface Contexte { acces: AccesIa; config: Awaited<ReturnType<typeof getRoleConfig>> }

async function contexte(user: CurrentUser): Promise<Contexte> {
  return { acces: await accesAssistantIa(user), config: await getRoleConfig(user.role) };
}

/** Les outils de la personne, MAINTENANT — la même fabrique que le tour écrit. */
function outilsDe(user: CurrentUser, c: Contexte, propositions: PropositionPreparee[], coffret: CoffretDuTour): PowerTool[] {
  return outilsV1(user, propositions, [], [], coffret, c.acces);
}

const enTempsReel = (o: PowerTool): OutilTempsReel => ({
  type: "function", name: o.def.name, description: o.def.description.slice(0, 1_000), parameters: o.def.input_schema as Record<string, unknown>,
});

const OUTIL_UTILISER_DEF: OutilTempsReel = {
  type: "function",
  name: OUTIL_UTILISER,
  description: "UTILISE un outil rendu par `trouver_outil` : son nom et ses arguments (selon le schéma rendu). Les droits de la personne sont revérifiés.",
  parameters: {
    type: "object",
    properties: { outil: { type: "string" }, arguments: { type: "object", additionalProperties: true } },
    required: ["outil"],
  },
};

export type OuvertureVoix = (SessionAccordee & { outils: string[] }) | { ok: false; erreur: string; statut: number };

export async function ouvrirVoixAssistant(user: CurrentUser, opts: { fetchImpl?: typeof fetch } = {}): Promise<OuvertureVoix> {
  if (!peutUtiliserAssistantIA(user)) return { ok: false, erreur: REFUS_ASSISTANT_IA, statut: 403 };
  if (user.impersonatedBy || user.visualise) return { ok: false, erreur: "Indisponible en « Vue exacte ».", statut: 403 };
  // Le plafond du jour : une session vocale qui ne pourrait rien dépenser ne s'ouvre pas.
  const budget = await auNomDe(user.id, () => budgetDeLAppel("synthese"));
  if (!budget.ok) return { ok: false, erreur: budget.raison, statut: 429 };
  if (budget.proprietaire) await fermerBudget(budget.budget, { ok: true, ms: 0 });

  const c = await contexte(user);
  const outils = outilsDe(user, c, [], new CoffretDuTour());
  const offertes = new Set(fichesOffertes(outils, user, c.config).map((f) => f.nom));
  const socle = SOCLE_OUTILS.filter((n) => n !== OUTIL_TROUVER && offertes.has(n));
  const selection = selectionDuTour(outils, user, "", c.config);
  const defs = [enTempsReel(selection.outil), ...outils.filter((o) => socle.includes(o.def.name)).map(enTempsReel), OUTIL_UTILISER_DEF];
  const sauf = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x);
  const instructions = (await compileContext({
    user, consignesRole: resoudreConsignesRole(c.config),
    consignesGenerales: [CONSIGNES_VOIX, CONSIGNE_SELECTION, `En voix, un outil trouvé s'appelle par « ${OUTIL_UTILISER} » (nom + arguments selon le schéma rendu).`],
    consignesPersonne: sauf([consigneFamilles(c.acces), consigneGestesFermes(user)]),
    outilsActifs: socle,
  })).systemPrompt;
  const s = await ouvrirSessionTempsReel({
    cle: cleFournisseurVoix(), modele: modeleTempsReel(), instructions, outils: defs, voix: VOIX_ASSISTANT,
    transcription: modeleSttTerrain(), langue: null, fetchImpl: opts.fetchImpl,
  });
  return s.ok ? { ...s, outils: defs.map((d) => d.name) } : s;
}

export interface ResultatOutilVoix {
  pourModele: string;
  carte?: PropositionPreparee["proposition"] & { intentId: string; status: "PROPOSED" };
  ecran?: string | null;
}

const refus = (raison: string): ResultatOutilVoix => ({ pourModele: JSON.stringify({ statut: "REFUS", raison }) });

/**
 * EXÉCUTER UN APPEL D'OUTIL DE LA VOIX — droits relus, repères gardés, carte à l'écran. `utiliser_outil` désigne
 * n'importe quel outil OFFERT à la personne (les mêmes fiches que `trouver_outil` cherche) ; rien d'autre.
 */
export async function executerOutilVocal(user: CurrentUser, nom: string, args: Record<string, unknown>): Promise<ResultatOutilVoix> {
  if (!peutUtiliserAssistantIA(user)) return refus(REFUS_ASSISTANT_IA);
  let cible = nom;
  let entree = args ?? {};
  if (nom === OUTIL_UTILISER) {
    cible = typeof args.outil === "string" ? args.outil : "";
    entree = args.arguments && typeof args.arguments === "object" ? (args.arguments as Record<string, unknown>) : {};
  }
  if (!cible || cible === OUTIL_UTILISER || outilInterditALaVoix(cible)) {
    return refus("Cet outil ne s'appelle pas à la voix : une écriture se confirme à l'écran, sur sa carte.");
  }
  const c = await contexte(user);
  const coffret = new CoffretDuTour();
  const propositions: PropositionPreparee[] = [];
  const outils = outilsDe(user, c, propositions, coffret);
  const selection = selectionDuTour(outils, user, "", c.config);
  const offertes = new Set(fichesOffertes(outils, user, c.config).map((f) => f.nom));
  const outil = cible === OUTIL_TROUVER ? selection.outil : outils.find((o) => o.def.name === cible && offertes.has(cible));
  if (!outil || !outil.allowed(user)) return refus("Cet outil n'est pas ouvert à cette personne (ses droits, ou une famille fermée par la Direction). Dis-le.");

  const sortie = await auNomDe(user.id, () => outil.run(entree, user));
  let pourModele = sortie;
  if (cible === OUTIL_TROUVER) {
    // En voix, l'outil trouvé s'appelle par `utiliser_outil` : il lui faut son schéma.
    try {
      const r = JSON.parse(sortie) as { trouves?: { outil: string; quoi: string }[] };
      const schemas = Object.fromEntries((r.trouves ?? []).map((t) => [t.outil, outils.find((o) => o.def.name === t.outil)?.def.input_schema ?? {}]));
      pourModele = JSON.stringify({ ...r, schemas, consigne: `Appelle « ${OUTIL_UTILISER} » avec l'outil choisi et ses arguments.` });
    } catch { /* sortie libre : rendue telle quelle */ }
  }
  const p = propositions[0];
  // L'ÉCRAN, ET LUI SEUL, voit la valeur — si la personne y a droit (politique du coffre, journal).
  const ecran = reperesDe(sortie).length ? await new Revelateur(coffret, user, c.acces).texte(sortie) : null;
  return {
    // Les schémas de `trouver_outil` ne se coupent pas (un JSON coupé est illisible) : la borne est plus large.
    pourModele: pourLaVoix(p ? JSON.stringify({ statut: "CARTE_A_L_ECRAN", titre: p.proposition.title, consigne: "La carte est affichée : dis-le, et que seule la personne la confirme à l'écran. Ne dis jamais que c'est fait." }) : pourModele, cible === OUTIL_TROUVER ? 24_000 : undefined),
    ...(p ? { carte: { ...p.proposition, intentId: p.intentId, status: "PROPOSED" as const } } : {}),
    ecran,
  };
}

/**
 * LE JOURNAL D'UNE SESSION VOCALE : sa consommation (les jetons que le fournisseur a rendus) au compte de la personne, et
 * ses latences (de la fin de la parole au premier son) dans les journaux d'exploitation.
 */
export async function journaliserVoix(user: CurrentUser, d: { entree: number; sortie: number; latences: number[]; dureeMs: number }): Promise<void> {
  const borne = (n: unknown, max: number) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : 0);
  const entree = borne(d.entree, 5_000_000);
  const sortie = borne(d.sortie, 5_000_000);
  const latences = (Array.isArray(d.latences) ? d.latences : []).map((x) => borne(x, 120_000)).slice(0, 500);
  await auNomDe(user.id, () => appelVoix("synthese", async (inscrire) => {
    inscrire({ provider: "openai-realtime", model: modeleTempsReel(), entree, sortie, ms: borne(d.dureeMs, 7_200_000) });
    return { ok: true, valeur: null };
  }));
  const tri = [...latences].sort((a, b) => a - b);
  console.info("[assistant-ia] voix temps réel", { userId: user.id, entree, sortie, reponses: latences.length, p50: tri.length ? tri[Math.floor(tri.length / 2)] : null });
}
