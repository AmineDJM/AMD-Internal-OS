/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉVALUATEUR DE LA GARDE (lot D3, décision 0057) — le juge que le socle appelle pour chaque requête.
 *
 * Il doit être SYNCHRONE et quasi gratuit : il est appelé des milliers de fois par page. D'où un INSTANTANÉ des
 * réglages en mémoire, rafraîchi en arrière-plan (toutes les 30 s, et jamais sur le chemin de la requête). Un
 * instantané vide ne juge rien : au démarrage, l'ERP se comporte exactement comme avant.
 *
 * D3 : il COMPTE ce qui aurait été refusé (`ObservationAccesBase`), il ne refuse pas. Le refus réel est le lot D4.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prismaBrut } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { enSysteme, estSysteme, poserEvaluateurDonnees, poserModulesParBase, type EvaluateurDonnees, type ModulesParBase } from "@/platform/donnees/contexte";
import { CATALOGUE_BASES } from "../domaine/catalogue.genere";
import {
  COLONNES_REFERENCE, appliqueeSur, baseDe, baseDuModele, droitEffectif, droitParModules, empreinteRefus, estModeStrict,
  niveauPour, type ModeStrict,
} from "../domaine/regle";
import type { ReglageBase } from "../domaine/types";
import { compterObservation } from "./observations";
import { propresDonnees, reglagesVivants } from "./reglages";

const FRAICHEUR_MS = 30_000;

/** Ce que l'évaluateur sait, en mémoire : les réglages, le mode strict, ses propres données par base, la fiche RH de chacun. */
interface Instantane {
  reglages: readonly ReglageBase[];
  strict: ModeStrict;
  propres: Readonly<Record<string, boolean>>;
  fiches: ReadonlyMap<string, string>;
  expire: number;
}
const VIDE: Omit<Instantane, "expire"> = { reglages: [], strict: "AUCUNE", propres: {}, fiches: new Map() };
let instantane: Instantane = { ...VIDE, expire: 0 };
let enCours = false;

/** Relit tout, hors de toute personne (contexte système) : l'évaluateur ne se juge pas lui-même. */
async function relire(): Promise<Omit<Instantane, "expire">> {
  return enSysteme("instantané de l'accès par base", async () => {
    const [reglages, reglage, propres, fiches] = await Promise.all([
      reglagesVivants(),
      prismaBrut.appSetting.findUnique({ where: { id: "global" }, select: { accesBasesStrict: true } }),
      propresDonnees(),
      prismaBrut.employee.findMany({ where: { userId: { not: null } }, select: { id: true, userId: true } }),
    ]);
    const mode = reglage?.accesBasesStrict;
    return {
      reglages, propres,
      strict: estModeStrict(mode) ? mode : "AUCUNE",
      fiches: new Map(fiches.map((f) => [f.userId!, f.id])),
    };
  });
}

/** Rafraîchit l'instantané en arrière-plan : la requête qui a vu l'instantané périmé n'attend pas. */
function rafraichirSiBesoin(): void {
  if (enCours || Date.now() < instantane.expire) return;
  enCours = true;
  instantane = { ...instantane, expire: Date.now() + FRAICHEUR_MS };
  void relire()
    .then((i) => { instantane = { ...i, expire: Date.now() + FRAICHEUR_MS }; })
    .catch(sansBloquer("acces-bases: instantané des réglages"))
    .finally(() => { enCours = false; });
}

/** Relit l'instantané TOUT DE SUITE (après un réglage de la console : la garde n'attend pas 30 s). */
export async function rafraichirGardeMaintenant(): Promise<void> {
  instantane = { ...(await relire()), expire: Date.now() + FRAICHEUR_MS };
}

/** Pour les bancs : impose un instantané (ou le vide) sans attendre le rafraîchissement. */
export function poserInstantaneDeTest(reglages: readonly ReglageBase[] | null, autre: Partial<Omit<Instantane, "reglages" | "expire">> = {}): void {
  instantane = reglages ? { ...VIDE, ...autre, reglages, expire: Date.now() + FRAICHEUR_MS } : { ...VIDE, expire: 0 };
}

export const evaluateurAccesBases: EvaluateurDonnees = ({ modele, geste, contexte }) => {
  rafraichirSiBesoin();
  if (!contexte || estSysteme(contexte)) return null; // une tâche de fond déclarée n'est pas une personne
  if (!instantane.reglages.length) return null; // aucun réglage : rien à juger
  const cle = baseDuModele(modele);
  const base = cle ? baseDe(cle) : null;
  // Les bases TECHNIQUES ne se règlent pas : l'ERP ne tourne pas sans elles (comptes, journaux, plateforme).
  if (!base || base.nature === "technique") return null;

  const n = niveauPour({ userId: contexte.userId, roles: contexte.roles }, base.cle, instantane.reglages, new Date());
  if (n.niveau === "NORMAL") return null;
  const droit = droitEffectif(droitParModules(base, contexte.peut), n, base.nom);
  const permis = geste === "lecture" ? droit.lecture : droit.ecriture;
  if (permis) return null;

  compterObservation({ base: base.cle, userId: contexte.userId, geste, niveau: n.niveau, modele });
  const applique = appliqueeSur(instantane.strict, base);
  return {
    refus: `La base « ${base.nom} » vous est ${n.niveau === "FERMEE" ? "fermée" : "ouverte en lecture seule"} — demandez à la Direction.`,
    applique,
    digest: empreinteRefus(base.cle, n.niveau),
    reference: COLONNES_REFERENCE,
    // Ses propres données (paramètre de la base) : en lecture seulement — une base en lecture seule reste en lecture seule.
    propres: applique && geste === "lecture" && instantane.propres[base.cle]
      ? { userId: contexte.userId, employeId: instantane.fiches.get(contexte.userId) ?? null }
      : null,
  };
};

/** Les niveaux APPLIQUÉS des bases métier pour une personne (application stricte seulement) — `null` : rien d'appliqué. */
function niveauxAppliques(personne: { userId: string; roles: readonly (string | null | undefined)[] }) {
  rafraichirSiBesoin();
  if (!instantane.reglages.length || instantane.strict === "AUCUNE") return null;
  const maintenant = new Date();
  return CATALOGUE_BASES.filter((b) => appliqueeSur(instantane.strict, b))
    .map((b) => ({ base: b, n: niveauPour(personne, b.cle, instantane.reglages, maintenant) }))
    .filter((x) => x.n.niveau !== "NORMAL");
}

/**
 * D5 — CE QUE LES BASES FONT AUX MODULES : OUVERTE ouvre ses modules (lecture ; + créer / modifier si l'écriture est
 * accordée) ; un module dont TOUTES les bases métier sont fermées est masqué. Les modules des bases techniques
 * (Administration…) ne sont jamais masqués : aucun verrouillage possible.
 */
export const modulesParBaseAccesBases: ModulesParBase = (personne) => {
  const niveaux = niveauxAppliques(personne);
  if (!niveaux?.length) return null;
  const ouvrir = niveaux.filter((x) => x.n.niveau === "OUVERTE")
    .flatMap((x) => x.base.modules.map((module) => ({ module, gestes: x.n.ecriture ? ["VIEW", "CREATE", "UPDATE"] : ["VIEW"] })));
  const fermees = new Set(niveaux.filter((x) => x.n.niveau === "FERMEE").map((x) => x.base.cle));
  const basesDuModule = new Map<string, string[]>();
  for (const b of CATALOGUE_BASES) for (const m of b.modules) basesDuModule.set(m, [...(basesDuModule.get(m) ?? []), b.cle]);
  const masquer = [...basesDuModule].filter(([, bases]) => bases.every((b) => fermees.has(b))).map(([m]) => m);
  return { ouvrir, masquer };
};

/**
 * D5 — CE QUE LES BASES FONT AUX FAMILLES DE L'ASSISTANT IA : une base fermée ferme ses familles, une base ouverte les
 * ouvre ; une ouverture NOMINATIVE d'une base porteuse d'une famille sensible (Paie → salaires, Personnel → contrats RH)
 * devient un périmètre nommé (origine « base »), journalisé à chaque révélation comme les droits datés de S1. Une
 * ouverture de RÔLE n'ouvre jamais les valeurs sensibles d'autrui.
 */
export function famillesParBase(personne: { userId: string; roles: readonly (string | null | undefined)[] }): {
  fermees: string[]; ouvertes: string[]; perimetres: { famille: string; du: string; au: string | null; ref: string; motif: string }[];
} | null {
  const niveaux = niveauxAppliques(personne);
  if (!niveaux?.length) return null;
  const fermees = new Set<string>();
  const ouvertes = new Set<string>();
  const perimetres: { famille: string; du: string; au: string | null; ref: string; motif: string }[] = [];
  for (const { base, n } of niveaux) {
    if (n.niveau === "FERMEE") base.famillesIa.forEach((f) => fermees.add(f));
    if (n.niveau !== "OUVERTE") continue;
    base.famillesIa.forEach((f) => ouvertes.add(f));
    const r = n.source === "personne" ? instantane.reglages.find((x) => x.id === n.reglageId) : null;
    if (r) for (const f of base.famillesIa) {
      perimetres.push({ famille: f, du: r.du.toISOString(), au: r.au ? r.au.toISOString() : null, ref: r.id, motif: r.motif ?? `Base « ${base.nom} » ouverte` });
    }
  }
  // Une base fermée l'emporte sur une autre ouverte qui porte la même famille.
  return {
    fermees: [...fermees],
    ouvertes: [...ouvertes].filter((f) => !fermees.has(f)),
    perimetres: perimetres.filter((p) => !fermees.has(p.famille)),
  };
}

/** Branche la garde (appelé au démarrage du serveur, `src/instrumentation.ts`). */
export function brancherGardeDonnees(): void {
  poserEvaluateurDonnees(evaluateurAccesBases);
  poserModulesParBase(modulesParBaseAccesBases);
}

/** Débranche la garde (fin de banc). */
export function debrancherGardeDonnees(): void {
  poserEvaluateurDonnees(null);
  poserModulesParBase(null);
}

/**
 * I4 (décision 0067) — LE DROIT DE LIRE UNE TABLE, pour la lecture générique d'Adam : les modules de sa base ET le niveau
 * réglé. Contrairement à la garde, il s'APPLIQUE même hors du mode strict (une IA échoue fermé : une base fermée par la
 * Direction ne se lit pas par Adam, même quand l'écran ne fait encore que compter). Une base TECHNIQUE n'a pas de module
 * qui la porte : c'est la portée des lignes, déclarée table par table, qui la borne. `null` : table hors catalogue.
 */
export function droitDeLireTable(
  personne: { userId: string; roles: readonly (string | null | undefined)[]; peut: (module: string, geste: string) => boolean },
  modele: string,
): { base: string; nomBase: string; lecture: boolean; chemin: string } | null {
  rafraichirSiBesoin();
  const cle = baseDuModele(modele);
  const base = cle ? baseDe(cle) : null;
  if (!base) return null;
  const n = niveauPour(personne, base.cle, instantane.reglages, new Date());
  if (base.nature === "technique") return { base: base.cle, nomBase: base.nom, lecture: n.niveau !== "FERMEE", chemin: n.niveau === "FERMEE" ? `Base « ${base.nom} » fermée` : "Base technique : la portée des lignes décide" };
  const d = droitEffectif(droitParModules(base, personne.peut), n, base.nom);
  return { base: base.cle, nomBase: base.nom, lecture: d.lecture, chemin: d.chemin };
}
